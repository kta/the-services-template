import {
  CreateItem,
  domainAccessTokenAudience,
  EmailAddress,
  IssueTokenRequest,
  Item,
  Organization,
  type Plan,
} from '@app/contracts'
import {
  type AuthVariables,
  internalAuth,
  type OrgResolver,
  requireActiveOrg,
  requireLiveDomainSession,
  sendNotification,
  signAccessToken,
  tenantAuth,
} from '@app/shared'
import type { D1Database, Fetcher } from '@cloudflare/workers-types'
import { zValidator } from '@hono/zod-validator'
import { desc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { except } from 'hono/combine'
import { HTTPException } from 'hono/http-exception'
import { items, organizations } from './db/schema'
import { isFreshOrgSync } from './org-sync'

const DOMAIN_ACCESS_TOKEN_AUDIENCE = domainAccessTokenAudience('example_tauri_service')

// Imported explicitly (not the ambient global) so the exported AppType is
// self-contained and the web half can consume it without Workers types.
// The SPA is served as static assets from this same Worker (same origin),
// so there is no CORS anywhere in this service.
export type Bindings = {
  // Runtime environment marker. Production is fail-closed for credential-less
  // development authentication even if a remote variable is accidentally set.
  APP_ENV: 'development' | 'production' | string
  DB: D1Database
  // Notifier Worker: POST NotificationJob to /api/internal/send (this template does
  // not use Queues by design). Best-effort; the request still succeeds if it fails.
  NOTIFIER: Fetcher
  // admin → domain org-sync key. It is not reused for notifier calls.
  // This name is intentionally specific to the scaffold domain. A copied
  // domain must receive its own ADMIN_TO_<DOMAIN>_KEY and unique value.
  ADMIN_TO_EXAMPLE_TAURI_SERVICE_KEY: string
  // domain → notifier key. A compromised domain cannot impersonate admin.
  DOMAIN_TO_NOTIFIER_KEY: string
  // domain → admin live-session introspection key. This direction is separate
  // from admin→domain and domain→notifier credentials.
  DOMAIN_TO_ADMIN_KEY: string
  // Admin service binding used only for live-session checks. The domain does
  // not receive the admin D1 or JWT private key.
  ADMIN: Fetcher
  // RS256 verification key. The corresponding private key stays in admin and
  // must never be configured on a production domain Worker.
  JWT_PUBLIC_KEY: string
  // Enables the credential-less dev token grant (/api/auth/token). MUST be
  // unset/false in prod (fail close).
  AUTH_DEV_GRANT?: string
  // Local-only private key for the credential-less dev grant. Never set this
  // on a production domain Worker.
  AUTH_DEV_PRIVATE_KEY?: string
  // Allowlisted notification destination for this domain's item events.
  DOMAIN_NOTIFICATION_TO?: string
}

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>()
const AUTH_BODY_LIMIT_BYTES = 16 * 1024
const JSON_BODY_LIMIT_BYTES = 64 * 1024
const MAX_LIST_ROWS = 1_000
// The admin reconcile Cron runs hourly. One missed run is tolerated for
// availability; after two hours, a domain must reject the mirrored org rather
// than keep trusting an enabled row after the source of truth may have disabled it.
const authBodyLimit = bodyLimit({
  maxSize: AUTH_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'payload_too_large' }, 413),
})

// Schema validation happens after Hono materializes the JSON body. Bound all
// non-auth JSON routes first so unknown fields and internal sync requests cannot
// become an unbounded parser allocation.
const jsonBodyLimit = bodyLimit({
  maxSize: JSON_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'payload_too_large' }, 413),
})

function domainNotificationTarget(env: Bindings): string | null {
  const configured = env.DOMAIN_NOTIFICATION_TO?.trim()
  if (configured && EmailAddress.safeParse(configured).success) return configured
  return env.APP_ENV === 'development' ? 'team@example.com' : null
}

// Consistent JSON errors + structured logging for UNEXPECTED throws. Thrown
// HTTPExceptions keep their own status/response.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('unhandled', err)
  return c.json({ error: 'internal_error' }, 500)
})

// Internal endpoints: caller-specific-key guarded (admin Worker → service binding).
// Fail close when the secret is unset (see @app/shared internalAuth).
app.use(
  '/api/internal/*',
  internalAuth<{ Bindings: Bindings }>('ADMIN_TO_EXAMPLE_TAURI_SERVICE_KEY'),
)

// Synced org row → contract shape. NULL/unknown state is not a safe default:
// a partially migrated or corrupted row must fail closed rather than silently
// becoming an active free tenant.
function isValidOrgSyncVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function toOrgFields(r: typeof organizations.$inferSelect, nowMs = Date.now()) {
  const plan = r.plan === 'free' || r.plan === 'contracted' ? r.plan : null
  const isDisabled = r.isDisabled === '0' ? false : r.isDisabled === '1' ? true : null
  if (
    plan === null ||
    isDisabled === null ||
    !isValidOrgSyncVersion(r.version) ||
    !isFreshOrgSync(r.syncedAt, nowMs)
  )
    return null
  return {
    id: r.id,
    name: r.name,
    plan: plan as Plan,
    isDisabled,
    version: r.version,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
  }
}

// Resolve the synced organization row for the current tenant. Row absent =
// not yet synced from admin (→ 503 not_synced, retryable); disabled = 403.
const orgResolver: OrgResolver = async (orgId, c) => {
  const db = drizzle((c.env as Bindings).DB)
  const rows = await db.select().from(organizations).where(eq(organizations.id, orgId))
  const row = rows[0]
  if (!row) return null
  const mapped = toOrgFields(row)
  if (!mapped) return null
  return { plan: mapped.plan, isDisabled: mapped.isDisabled }
}

// Default-deny: EVERY /api/* route requires a tenant JWT + active org unless
// explicitly exempted (health, auth, internal — internal has its own key guard
// above). New routes are protected without remembering to add middleware.
app.use(
  '/api/*',
  except(
    ['/api/health', '/api/auth/token', '/api/internal/*'],
    tenantAuth(undefined, DOMAIN_ACCESS_TOKEN_AUDIENCE),
    requireLiveDomainSession(),
    requireActiveOrg(orgResolver),
  ),
)

// DEV-ONLY token grant (NOT in the RPC routes). Mints an access JWT for ANY
// organizationId with no credential check — fail-closed unless
// AUTH_DEV_GRANT === 'true'. Replace with a real auth proxy to the admin
// Worker (or an IdP flow) before any real deployment.
app.post('/api/auth/token', authBodyLimit, zValidator('json', IssueTokenRequest), async (c) => {
  if (
    c.env.APP_ENV !== 'development' ||
    c.env.AUTH_DEV_GRANT !== 'true' ||
    !c.env.AUTH_DEV_PRIVATE_KEY
  ) {
    return c.json({ error: 'not_found' }, 404)
  }
  const { organizationId, role, email } = c.req.valid('json')
  // Dev convenience: ensure the org sync row exists so /api/items doesn't 503.
  // In real flows the row arrives from the admin Worker over the service binding.
  const db = drizzle(c.env.DB)
  await db
    .insert(organizations)
    .values({
      id: organizationId,
      name: organizationId,
      plan: 'free',
      isDisabled: '0',
      version: 1,
      syncedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: organizations.id })
  const token = await signAccessToken(
    { sub: `dev:${organizationId}`, org: organizationId, email, role },
    c.env.AUTH_DEV_PRIVATE_KEY,
    undefined,
    undefined,
    DOMAIN_ACCESS_TOKEN_AUDIENCE,
  )
  return c.json({ token })
})

// Routes are chained so `typeof routes` captures them for the Hono RPC client.
const routes = app
  .get('/api/health', (c) => c.json({ status: 'ok' as const }))
  // Idempotent upsert of a synced organization (cross-D1 reconciliation; the
  // admin Worker is the source of truth and pushes the full Organization).
  .post(
    '/api/internal/organizations',
    jsonBodyLimit,
    zValidator('json', Organization),
    async (c) => {
      const db = drizzle(c.env.DB)
      const org = c.req.valid('json')
      const row = {
        id: org.id,
        name: org.name,
        plan: org.plan,
        isDisabled: org.isDisabled ? ('1' as const) : ('0' as const),
        version: org.version,
        syncedAt: new Date().toISOString(),
        createdAt: org.createdAt,
      }
      const updated = await db
        .insert(organizations)
        .values(row)
        .onConflictDoUpdate({
          target: organizations.id,
          set: {
            name: row.name,
            plan: row.plan,
            isDisabled: row.isDisabled,
            version: row.version,
            syncedAt: row.syncedAt,
          },
          setWhere: sql`coalesce(${organizations.version}, 0) <= ${row.version}`,
        })
        .returning({ id: organizations.id })
      if (updated.length === 0) return c.json({ error: 'stale_sync' as const }, 409)
      return c.json(org, 200)
    },
  )
  // List the synced org rows — the admin Worker's hourly reconcile Cron reads
  // this to detect admin↔domain drift.
  .get('/api/internal/organizations', async (c) => {
    const db = drizzle(c.env.DB)
    const rows = await db
      .select()
      .from(organizations)
      .limit(MAX_LIST_ROWS + 1)
    if (rows.length > MAX_LIST_ROWS) return c.json({ error: 'too_many_results' }, 413)
    return c.json(
      Organization.array().parse(
        rows.flatMap((row) => {
          const mapped = toOrgFields(row)
          return mapped ? [mapped] : []
        }),
      ),
    )
  })
  .get('/api/items', async (c) => {
    const db = drizzle(c.env.DB)
    const org = c.get('auth').org
    const rows = await db
      .select()
      .from(items)
      .where(eq(items.organizationId, org))
      .orderBy(desc(items.createdAt))
      .limit(MAX_LIST_ROWS + 1)
    if (rows.length > MAX_LIST_ROWS) return c.json({ error: 'too_many_results' }, 413)
    // Validate/serialize through the Zod contract so the response shape is the
    // single source of truth (and the client needs no cast).
    return c.json(Item.array().parse(rows))
  })
  .post('/api/items', jsonBodyLimit, zValidator('json', CreateItem), async (c) => {
    const db = drizzle(c.env.DB)
    const org = c.get('auth').org
    const input = c.req.valid('json')
    const row = {
      id: crypto.randomUUID(),
      organizationId: org,
      title: input.title,
      body: input.body,
      createdAt: new Date().toISOString(),
    }
    await db.insert(items).values(row)

    // Notify via the notifier binding (best-effort; the request still succeeds
    // if it fails — sendNotification logs non-2xx and never throws). No queue by
    // design. The job id is derived from the item id so the notifier
    // dedupes redeliveries. waitUntil keeps the 201 from blocking on the
    // notifier — the item row is already committed, so a slow/hung notifier
    // must not stall every item creation.
    const notificationTarget = domainNotificationTarget(c.env)
    if (notificationTarget) {
      c.executionCtx.waitUntil(
        sendNotification(c.env.NOTIFIER, c.env.DOMAIN_TO_NOTIFIER_KEY, 'domain', {
          id: `item.created:${row.id}`,
          type: 'item.created',
          to: notificationTarget,
          payload: { itemId: row.id, title: row.title },
        }),
      )
    } else {
      console.error('item notification skipped: DOMAIN_NOTIFICATION_TO is missing or invalid')
    }

    return c.json(row, 201)
  })

// The web half imports this type (type-only) for the `hc<AppType>` client.
export type AppType = typeof routes

export default app
