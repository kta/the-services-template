import { CreateItem, IssueTokenRequest, Item, Organization, type Plan } from '@app/contracts'
import {
  type AuthVariables,
  internalAuth,
  type OrgResolver,
  requireActiveOrg,
  sendNotification,
  signAccessToken,
  tenantAuth,
} from '@app/shared'
import type { D1Database, Fetcher } from '@cloudflare/workers-types'
import { zValidator } from '@hono/zod-validator'
import { desc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { except } from 'hono/combine'
import { HTTPException } from 'hono/http-exception'
import { items, organizations } from './db/schema'

// Imported explicitly (not the ambient global) so the exported AppType is
// self-contained and the web half can consume it without Workers types.
// The SPA is served as static assets from this same Worker (same origin),
// so there is no CORS anywhere in this service.
export type Bindings = {
  DB: D1Database
  // Notifier Worker: POST NotificationJob to /api/internal/send (this template does
  // not use Queues by design). Best-effort; the request still succeeds if it fails.
  NOTIFIER: Fetcher
  // Guards /api/internal/* (called by other Workers via a service binding).
  INTERNAL_KEY: string
  // HS256 signing secret for access JWTs. Must match the admin Worker's (the
  // auth source of truth). Set via `wrangler secret put`.
  JWT_SECRET: string
  // Enables the credential-less dev token grant (/api/auth/token). MUST be
  // unset/false in prod (fail close).
  AUTH_DEV_GRANT?: string
}

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>()

// Consistent JSON errors + structured logging for UNEXPECTED throws. Thrown
// HTTPExceptions keep their own status/response.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('unhandled', err)
  return c.json({ error: 'internal_error' }, 500)
})

// Internal endpoints: shared-key guarded (admin Worker → service binding).
// Fail close when the secret is unset (see @app/shared internalAuth).
app.use('/api/internal/*', internalAuth())

// Synced org row → contract shape. NULL plan/is_disabled are legacy rows from
// before the columns existed (SQLite ALTER ADD COLUMN cannot backfill) — treat
// them as free/enabled. Single mapping point so the null semantics live here only.
function toOrgFields(r: typeof organizations.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    plan: (r.plan ?? 'free') as Plan,
    isDisabled: r.isDisabled === '1',
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
  const { plan, isDisabled } = toOrgFields(row)
  return { plan, isDisabled }
}

// Default-deny: EVERY /api/* route requires a tenant JWT + active org unless
// explicitly exempted (health, auth, internal — internal has its own key guard
// above). New routes are protected without remembering to add middleware.
app.use(
  '/api/*',
  except(
    ['/api/health', '/api/auth/*', '/api/internal/*'],
    tenantAuth(),
    requireActiveOrg(orgResolver),
  ),
)

// DEV-ONLY token grant (NOT in the RPC routes). Mints an access JWT for ANY
// organizationId with no credential check — fail-closed unless
// AUTH_DEV_GRANT === 'true'. Replace with a real auth proxy to the admin
// Worker (or an IdP flow) before any real deployment.
app.post('/api/auth/token', zValidator('json', IssueTokenRequest), async (c) => {
  if (c.env.AUTH_DEV_GRANT !== 'true') return c.json({ error: 'not_found' }, 404)
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
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: organizations.id })
  const token = await signAccessToken(
    { sub: `dev:${organizationId}`, org: organizationId, email, role },
    c.env.JWT_SECRET,
  )
  return c.json({ token })
})

// Routes are chained so `typeof routes` captures them for the Hono RPC client.
const routes = app
  .get('/api/health', (c) => c.json({ status: 'ok' as const }))
  // Idempotent upsert of a synced organization (cross-D1 reconciliation; the
  // admin Worker is the source of truth and pushes the full Organization).
  .post('/api/internal/organizations', zValidator('json', Organization), async (c) => {
    const db = drizzle(c.env.DB)
    const org = c.req.valid('json')
    const row = {
      id: org.id,
      name: org.name,
      plan: org.plan,
      isDisabled: org.isDisabled ? ('1' as const) : ('0' as const),
      createdAt: org.createdAt,
    }
    await db
      .insert(organizations)
      .values(row)
      .onConflictDoUpdate({
        target: organizations.id,
        set: { name: row.name, plan: row.plan, isDisabled: row.isDisabled },
      })
    return c.json(org, 200)
  })
  // List the synced org rows — the admin Worker's daily reconcile Cron reads
  // this to detect admin↔domain drift.
  .get('/api/internal/organizations', async (c) => {
    const db = drizzle(c.env.DB)
    const rows = await db.select().from(organizations)
    return c.json(Organization.array().parse(rows.map(toOrgFields)))
  })
  .get('/api/items', async (c) => {
    const db = drizzle(c.env.DB)
    const org = c.get('auth').org
    const rows = await db
      .select()
      .from(items)
      .where(eq(items.organizationId, org))
      .orderBy(desc(items.createdAt))
    // Validate/serialize through the Zod contract so the response shape is the
    // single source of truth (and the client needs no cast).
    return c.json(Item.array().parse(rows))
  })
  .post('/api/items', zValidator('json', CreateItem), async (c) => {
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
    c.executionCtx.waitUntil(
      sendNotification(c.env.NOTIFIER, c.env.INTERNAL_KEY, {
        id: `item.created:${row.id}`,
        type: 'item.created',
        to: 'team@example.com',
        payload: { itemId: row.id, title: row.title },
      }),
    )

    return c.json(row, 201)
  })

// The web half imports this type (type-only) for the `hc<AppType>` client.
export type AppType = typeof routes

export default app
