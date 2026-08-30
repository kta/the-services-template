import {
  AcceptInviteRequest,
  AuthSessionCheckRequest,
  AuthSessionStatus,
  CreateOrganization,
  EmailAddress,
  InviteRequest,
  IssueTokenRequest,
  LoginRequest,
  type NotificationJob,
  Organization,
  Plan,
} from '@app/contracts'
import {
  type AuthVariables,
  generateRefreshToken,
  hashToken,
  internalAuth,
  REFRESH_TTL_SECONDS,
  requireRole,
  sendNotification,
  signAccessToken,
  tenantAuth,
} from '@app/shared'
import type { D1Database, Fetcher } from '@cloudflare/workers-types'
import { zValidator } from '@hono/zod-validator'
import { and, desc, eq, gt, isNull, lt, type SQL, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { except } from 'hono/combine'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import {
  type AuthDeps,
  acceptInvite,
  liveSessionStatus,
  login,
  refresh,
  revokeOne,
} from './auth/service'
import {
  authEvents,
  invitations,
  loginRateLimits,
  organizations,
  refreshTokens,
  users,
} from './db/schema'
import { reconcileOrgs } from './reconcile'
import {
  configuredDomainSyncEnvironments,
  listDomainOrgs,
  syncOrgToDomain,
  syncOrgToDomains,
} from './sync'

// The admin SPA is served by this same Worker (same origin) — no CORS.
export type Bindings = {
  // Runtime environment marker. Production is fail-closed for credential-less
  // development authentication even if a remote variable is accidentally set.
  APP_ENV: 'development' | 'production' | string
  DB: D1Database
  // JSON identities for catalog-deployable domain bindings. The template has
  // none in production; Vite/test config injects example_service explicitly.
  ADMIN_DOMAIN_IDENTITIES: string
  // Service binding to the notifier Worker (invite / ops mail, best-effort).
  NOTIFIER: Fetcher
  // Caller-specific service-binding keys. Keeping them separate limits the
  // blast radius if a domain/notifier/ops Worker is compromised.
  DOMAIN_TO_ADMIN_KEY: string
  ADMIN_TO_NOTIFIER_KEY: string
  // RS256 signing key. This private key must stay in admin; domain Workers only
  // receive JWT_PUBLIC_KEY and can therefore verify but not mint access tokens.
  JWT_PRIVATE_KEY: string
  // Public half used by admin's own tenantAuth middleware. It is safe to share
  // with every domain Worker and never enables signing.
  JWT_PUBLIC_KEY: string
  AUTH_PEPPER: string
  AUTH_DEV_GRANT?: string
  // Local-only private key for the credential-less dev grant. Production must
  // not configure it; the real login/refresh flow uses JWT_PRIVATE_KEY instead.
  AUTH_DEV_PRIVATE_KEY?: string
  // 招待リンクの基底 URL の明示オーバーライド(プロキシ/カスタムドメイン用)。
  // 未設定ならリクエストの origin から導出する(/invite はこの SPA 自身が配信)。
  INVITE_BASE_URL?: string
  // hourly 照合ドリフト通知の宛先(検証済み実メール)。未設定なら通知をスキップ。
  OPS_ALERT_EMAIL?: string
} & Record<string, unknown>

const REFRESH_COOKIE = 'rt'
const INVITE_TTL_SECONDS = 72 * 60 * 60
const AUTH_BODY_LIMIT_BYTES = 16 * 1024
const JSON_BODY_LIMIT_BYTES = 64 * 1024
const MAX_LIST_ROWS = 1_000

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>()

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('unhandled', err)
  return c.json({ error: 'internal_error' }, 500)
})

function authDeps(c: { env: Bindings }): AuthDeps {
  return {
    db: drizzle(c.env.DB),
    pepper: c.env.AUTH_PEPPER,
    jwtPrivateKey: c.env.JWT_PRIVATE_KEY,
  }
}
function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  const value = c.req.header('cf-connecting-ip')?.trim()
  const hasControlCharacter = value
    ? Array.from(value).some((character) => {
        const code = character.codePointAt(0) ?? 0
        return code <= 31 || code === 127
      })
    : false
  return value && value.length <= 64 && !hasControlCharacter ? value : 'unknown'
}

const authBodyLimit = bodyLimit({
  maxSize: AUTH_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'payload_too_large' }, 413),
})

// Zod runs after Hono has materialized the JSON body. Apply a separate bound
// to every non-auth JSON route so unknown fields cannot turn parsing into a
// memory sink even when the schema rejects them later.
const jsonBodyLimit = bodyLimit({
  maxSize: JSON_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: 'payload_too_large' }, 413),
})

function configuredAlertEmail(env: Bindings): string | null {
  const value = env.OPS_ALERT_EMAIL?.trim()
  return value && EmailAddress.safeParse(value).success ? value : null
}

/**
 * 招待リンクはユーザーがそのまま開く bearer credential を含むため、production
 * では管理者が明示した HTTPS origin 以外から生成しない。開発だけは同一 Worker の
 * request origin を使えるが、設定値が壊れている場合に安全な別 originへ黙って
 * フォールバックしない。
 */
export function inviteBaseUrl(c: {
  env: Pick<Bindings, 'APP_ENV' | 'INVITE_BASE_URL'>
  req: { url: string }
}): string | null {
  const configured = c.env.INVITE_BASE_URL?.trim()
  if (!configured && c.env.APP_ENV === 'production') return null
  try {
    const requestOrigin = new URL(c.req.url).origin
    const raw = configured || requestOrigin
    const url = new URL(raw)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null
    }
    if (
      c.env.APP_ENV === 'production' &&
      (url.protocol !== 'https:' || url.origin !== requestOrigin)
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}
function setRefreshCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/api/auth',
    maxAge: REFRESH_TTL_SECONDS,
  })
}
/** DB 行 → 契約 Organization。 */
function toOrganization(r: {
  id: string
  name: string
  plan: string
  isDisabled: string
  version: number
  createdAt: string
}): Organization {
  return Organization.parse({
    id: r.id,
    name: r.name,
    plan: r.plan,
    isDisabled: r.isDisabled === '1',
    version: r.version,
    createdAt: r.createdAt,
  })
}

/**
 * 運営者(オペレーター)ゲート。この管理コンソールはプラットフォーム運営者の
 * ツールであり、招待で作られた**テナント**の admin には触らせない(触らせると
 * 他組織の一覧・plan 変更・無効化・招待までできるクロステナント権限昇格になる)。
 * `organizations.isOperator === '1'` の org に属するユーザーだけを通す。
 * tenantAuth の後段に置く(c.var.auth 前提)。
 */
function requireOperator(): MiddlewareHandler<{
  Bindings: Bindings
  Variables: AuthVariables
}> {
  return async (c, next) => {
    const auth = c.get('auth')
    const orgId = auth?.org
    if (!orgId) return c.json({ error: 'unauthorized' }, 401)
    const rows = await drizzle(c.env.DB)
      .select({ isOperator: organizations.isOperator, isDisabled: organizations.isDisabled })
      .from(organizations)
      .where(eq(organizations.id, orgId))
    // Check the live organization row on every management request. A token
    // issued before an operator org was disabled must not retain management
    // privileges for the remainder of its 15-minute access-token lifetime.
    if (rows[0]?.isOperator !== '1' || rows[0].isDisabled !== '0') {
      return c.json({ error: 'operator_only' }, 403)
    }
    // The JWT role is only an assertion made at token issuance time. Check the
    // current user row as well, so a user that was downgraded, disabled by
    // removing its password, or removed from the operator org cannot keep the
    // management API until the 15-minute access token expires. The dev grant
    // intentionally has no DB user, but is available only in development and
    // is never accepted by a production configuration.
    if (auth.sub.startsWith('dev:')) {
      if (c.env.APP_ENV !== 'development' || c.env.AUTH_DEV_GRANT !== 'true') {
        return c.json({ error: 'operator_only' }, 403)
      }
    } else {
      const userRows = await drizzle(c.env.DB)
        .select({
          organizationId: users.organizationId,
          role: users.role,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(and(eq(users.id, auth.sub), eq(users.organizationId, orgId)))
      const user = userRows[0]
      if (user?.role !== 'admin' || !user.passwordHash) {
        return c.json({ error: 'operator_only' }, 403)
      }
    }
    await next()
  }
}

/**
 * Access JWT を admin D1 の未失効 refresh session に束縛する。
 *
 * 署名と exp だけで通すと、logout / refresh rotation / reuse 検知の後も
 * 最大 15 分間は既発行 access token が管理 API を叩けてしまう。JWT の sid
 * を主キーで照合し、revoked / rotated / expired の行を拒否することで、
 * 管理 API のセッション失効を即時反映する。dev grant は DB セッションを
 * 作らないため、development の明示的な grant 条件を満たす場合だけ免除する。
 */
function requireLiveAccessSession(): MiddlewareHandler<{
  Bindings: Bindings
  Variables: AuthVariables
}> {
  return async (c, next) => {
    const auth = c.get('auth')
    if (!auth) return c.json({ error: 'unauthorized' }, 401)
    if (auth.sub.startsWith('dev:')) {
      if (c.env.APP_ENV === 'development' && c.env.AUTH_DEV_GRANT === 'true') {
        await next()
        return
      }
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (!auth.sid) return c.json({ error: 'unauthorized' }, 401)
    const sessions = await drizzle(c.env.DB)
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.id, auth.sid),
          eq(refreshTokens.userId, auth.sub),
          eq(refreshTokens.organizationId, auth.org),
          isNull(refreshTokens.revokedAt),
          isNull(refreshTokens.rotatedTo),
          gt(refreshTokens.expiresAt, new Date().toISOString()),
        ),
      )
      .limit(1)
    if (!sessions[0]) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }
}

// Internal endpoints: caller-specific-key guarded (other Workers → service binding).
app.use('/api/internal/*', internalAuth<{ Bindings: Bindings }>('DOMAIN_TO_ADMIN_KEY'))

// Default-deny: EVERY /api/* route requires an operator-org admin JWT unless
// explicitly exempted (health / auth are public; internal has its own key
// guard above). 新ルートはミドルウェアを足し忘れても保護される。
app.use(
  '/api/*',
  except(
    [
      '/api/health',
      '/api/auth/login',
      '/api/auth/refresh',
      '/api/auth/logout',
      '/api/auth/accept-invite',
      '/api/auth/token',
      '/api/internal/*',
    ],
    tenantAuth(),
    requireLiveAccessSession(),
    requireRole('admin'),
    requireOperator(),
  ),
)

const routes = app
  .get('/api/health', (c) => c.json({ status: 'ok' as const }))

  // Domain Workers use this introspection endpoint after verifying the JWT
  // signature and domain audience locally. The admin Worker owns the refresh
  // session database, so logout/rotation/user/org changes are reflected at
  // the domain boundary without sharing a JWT private key.
  .post(
    '/api/internal/auth/session',
    jsonBodyLimit,
    zValidator('json', AuthSessionCheckRequest),
    async (c) => {
      if (c.req.header('x-internal-caller') !== 'domain') {
        return c.json({ error: 'unauthorized' }, 401)
      }
      return c.json(
        AuthSessionStatus.parse(await liveSessionStatus(authDeps(c), c.req.valid('json'))),
        200,
      )
    },
  )

  // ---- Public auth API (admin SPA, same origin) ----
  // Domain authentication/token issuance remains an application-specific
  // proxy/IdP concern; the internal session endpoint above only answers the
  // live-state question and never returns private key material.
  .post('/api/auth/login', authBodyLimit, zValidator('json', LoginRequest), async (c) => {
    const out = await login(authDeps(c), { ...c.req.valid('json'), ip: clientIp(c) })
    if (!out.ok) {
      if (out.retryAfter) c.header('Retry-After', String(out.retryAfter))
      return c.json({ error: out.error }, out.status)
    }
    setRefreshCookie(c, out.response.refreshToken)
    const { refreshToken: _omit, ...body } = out.response
    return c.json(body, 200)
  })
  .post('/api/auth/refresh', async (c) => {
    const rt = getCookie(c, REFRESH_COOKIE)
    if (!rt) return c.json({ error: 'no_session' }, 401)
    const out = await refresh(authDeps(c), { refreshToken: rt })
    if (!out.ok) {
      // keepCookie(マルチタブ競合の負け側)では削除しない — ブラウザには勝者の
      // 新 cookie が既に載っており、削除応答はそれを巻き添えで消す。
      if (!out.keepCookie) deleteCookie(c, REFRESH_COOKIE, { path: '/api/auth' })
      return c.json({ error: out.error }, out.status)
    }
    setRefreshCookie(c, out.response.refreshToken)
    return c.json({ token: out.response.token }, 200)
  })
  .post('/api/auth/logout', async (c) => {
    const rt = getCookie(c, REFRESH_COOKIE)
    let revokeFailed = false
    try {
      if (rt) await revokeOne(authDeps(c), rt)
    } catch (error) {
      revokeFailed = true
      console.error('logout revoke failed', error)
    } finally {
      // Even when D1 is unavailable, clear the browser cookie in this response.
      // A failed revoke is reported instead of pretending logout was complete.
      deleteCookie(c, REFRESH_COOKIE, { path: '/api/auth' })
    }
    if (revokeFailed) return c.json({ ok: false as const, error: 'logout_incomplete' }, 503)
    return c.json({ ok: true as const })
  })
  // Public invite acceptance (the admin SPA hosts the /invite route). Sets the
  // refresh cookie like login and returns the same body (without refreshToken).
  .post(
    '/api/auth/accept-invite',
    authBodyLimit,
    zValidator('json', AcceptInviteRequest),
    async (c) => {
      const out = await acceptInvite(authDeps(c), c.req.valid('json'))
      if (!out.ok) return c.json({ error: out.error }, out.status)
      setRefreshCookie(c, out.response.refreshToken)
      const { refreshToken: _omit, ...body } = out.response
      return c.json(body, 200)
    },
  )
  // DEV-ONLY grant: mints an admin JWT with no credential check. Fail-closed
  // unless AUTH_DEV_GRANT === 'true' and a local-only dev signing key exists.
  // Never enable/configure it in prod (docs/howto/deploy.md).
  .post('/api/auth/token', authBodyLimit, zValidator('json', IssueTokenRequest), async (c) => {
    if (
      c.env.APP_ENV !== 'development' ||
      c.env.AUTH_DEV_GRANT !== 'true' ||
      !c.env.AUTH_DEV_PRIVATE_KEY
    ) {
      return c.json({ error: 'not_found' }, 404)
    }
    const { organizationId, role, email } = c.req.valid('json')
    // Dev convenience: ensure the org exists as an OPERATOR org so the minted
    // JWT can use the management API(requireOperator)。dev グラント自体が
    // AUTH_DEV_GRANT でゲートされているので本番には存在しない経路。
    await drizzle(c.env.DB)
      .insert(organizations)
      .values({
        id: organizationId,
        name: organizationId,
        plan: 'free',
        isDisabled: '0',
        isOperator: '1',
        version: 1,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing({ target: organizations.id })
    const token = await signAccessToken(
      { sub: `dev:${organizationId}`, org: organizationId, email, role },
      c.env.AUTH_DEV_PRIVATE_KEY,
    )
    return c.json({ token })
  })

  // ---- Organizations (operator-admin only, via the default-deny gate) ----
  .get('/api/organizations', async (c) => {
    const db = drizzle(c.env.DB)
    const rows = await db
      .select()
      .from(organizations)
      .orderBy(desc(organizations.createdAt))
      .limit(MAX_LIST_ROWS + 1)
    if (rows.length > MAX_LIST_ROWS) return c.json({ error: 'too_many_results' }, 413)
    return c.json(rows.map(toOrganization))
  })
  .post(
    '/api/organizations',
    jsonBodyLimit,
    zValidator('json', CreateOrganization.extend({ plan: Plan.optional() })),
    async (c) => {
      const db = drizzle(c.env.DB)
      const input = c.req.valid('json')
      const org = {
        id: crypto.randomUUID(),
        name: input.name,
        plan: input.plan ?? 'free',
        isDisabled: '0',
        isOperator: '0',
        version: 1,
        createdAt: new Date().toISOString(),
      }
      await db.insert(organizations).values(org)
      // Reconcile into the domain D1 via the typed service binding (best-effort).
      // 結果は `synced` で応答に載せる — 失敗を握りつぶすと、無効化やプラン変更が
      // ドメイン側に届いていないことに次の hourly reconcile までオペレータが気づけない。
      const synced = await syncOrgToDomains(
        configuredDomainSyncEnvironments(c.env),
        toOrganization(org),
      )
      return c.json({ ...toOrganization(org), synced }, 201)
    },
  )
  .patch(
    '/api/organizations/:id',
    jsonBodyLimit,
    zValidator(
      'json',
      z.object({ plan: Plan.optional(), isDisabled: z.boolean().optional() }).strict(),
    ),
    async (c) => {
      const db = drizzle(c.env.DB)
      const id = c.req.param('id')
      const patch = c.req.valid('json')
      // 1 クエリで更新 + 更新後行の取得(SELECT→UPDATE の 2 往復と読み書き競合を防ぐ)。
      const set: Record<string, string | SQL> = {}
      if (patch.plan !== undefined) set.plan = patch.plan
      if (patch.isDisabled !== undefined) set.isDisabled = patch.isDisabled ? '1' : '0'
      if (Object.keys(set).length === 0) {
        const rows = await db.select().from(organizations).where(eq(organizations.id, id))
        return rows[0] ? c.json(toOrganization(rows[0])) : c.json({ error: 'not_found' }, 404)
      }
      // The revision is incremented in the same UPDATE as the state change.
      // Domain mirrors use it as a monotonic fence against service-binding
      // requests that arrive out of order.
      set.version = sql`coalesce(${organizations.version}, 0) + 1`
      const updated = await db
        .update(organizations)
        .set(set)
        .where(eq(organizations.id, id))
        .returning()
      const row = updated[0]
      if (!row) return c.json({ error: 'not_found' }, 404)
      const merged = toOrganization(row)
      const synced = await syncOrgToDomains(configuredDomainSyncEnvironments(c.env), merged)
      return c.json({ ...merged, synced })
    },
  )
  // Delete an organization: disable it + sync, keeping the canonical row as an
  // audit trail. 実プロダクトではここでドメイン側のデータ purge(service binding
  // の internal API)を呼ぶ — このテンプレートは無効化 + 同期のみに留める。
  .delete('/api/organizations/:id', async (c) => {
    const db = drizzle(c.env.DB)
    const id = c.req.param('id')
    const updated = await db
      .update(organizations)
      .set({ isDisabled: '1', version: sql`coalesce(${organizations.version}, 0) + 1` })
      .where(eq(organizations.id, id))
      .returning()
    const row = updated[0]
    if (!row) return c.json({ error: 'not_found' }, 404)
    // synced=false は「admin では無効化済みだがドメイン側はまだ有効」— service
    // binding が失敗した場合、domain の 2h lease が切れるまで API が生き残り得る。
    // UI が警告を出せるよう返す。
    const synced = await syncOrgToDomains(
      configuredDomainSyncEnvironments(c.env),
      toOrganization(row),
    )
    return c.json({ id, isDisabled: true as const, synced })
  })
  // Invite a user (staff by default) to an org: user(hash=null) + invitation +
  // best-effort notify. On notify failure, return the link for manual delivery.
  .post(
    '/api/organizations/:id/invitations',
    jsonBodyLimit,
    // 契約は Zod 単一ソース(@app/contracts の InviteRequest)— インラインで
    // 二重定義しない。
    zValidator('json', InviteRequest),
    async (c) => {
      const db = drizzle(c.env.DB)
      const orgId = c.req.param('id')
      const { email, role } = c.req.valid('json')
      const orgRows = await db.select().from(organizations).where(eq(organizations.id, orgId))
      if (!orgRows[0]) return c.json({ error: 'not_found' }, 404)
      // A disabled org must not accumulate fresh bearer invitations. Existing
      // pending invitations are rejected by acceptInvite as well; checking at
      // issuance closes the re-enable/old-invite window and gives operators a
      // single explicit state transition to audit.
      if (orgRows[0].isDisabled !== '0') {
        return c.json({ error: 'org_disabled' }, 403)
      }

      const base = inviteBaseUrl(c)
      if (!base) {
        console.error('invite base URL is not configured as a valid canonical origin')
        return c.json({ error: 'invite_unavailable' }, 503)
      }

      const now = new Date()
      const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase()))
      // クロステナント防御: 別 org に既存の email は招待できない(受諾時に他 org
      // ユーザーのパスワードを上書きする乗っ取り経路になるため)。同 org は再招待扱い。
      if (existing[0] && existing[0].organizationId !== orgId) {
        return c.json({ error: 'email_taken' }, 409)
      }
      // An accepted user must use a separate password-reset flow. Otherwise a
      // later re-invite could be abused to overwrite an existing password.
      if (existing[0]?.passwordHash) return c.json({ error: 'user_exists' }, 409)

      const token = generateRefreshToken()
      const inviteStmt = db.insert(invitations).values({
        id: crypto.randomUUID(),
        organizationId: orgId,
        email: email.toLowerCase(),
        tokenHash: await hashToken(token),
        expiresAt: new Date(now.getTime() + INVITE_TTL_SECONDS * 1000).toISOString(),
        consumedAt: null,
        createdAt: now.toISOString(),
      })
      // Create the pending user only if this email is new. A pending user's
      // role follows the latest invitation, but the conditional password-null
      // predicate prevents a concurrent acceptance from being changed after
      // it has become a real account.
      const userStmt = existing[0]
        ? db
            .update(users)
            .set({ role })
            .where(and(eq(users.id, existing[0].id), isNull(users.passwordHash)))
        : db.insert(users).values({
            id: crypto.randomUUID(),
            organizationId: orgId,
            email: email.toLowerCase(),
            passwordHash: null,
            role,
            createdAt: now.toISOString(),
          })
      const supersedeStmt = existing[0]
        ? db
            .update(invitations)
            .set({ consumedAt: now.toISOString(), consumedNonce: null })
            .where(
              and(
                eq(invitations.organizationId, orgId),
                eq(invitations.email, email.toLowerCase()),
                isNull(invitations.consumedAt),
              ),
            )
        : undefined
      await db.batch(
        supersedeStmt
          ? userStmt
            ? [supersedeStmt, inviteStmt, userStmt]
            : [supersedeStmt, inviteStmt]
          : userStmt
            ? [inviteStmt, userStmt]
            : [inviteStmt],
      )

      // The token is a bearer credential. Put it in the URL fragment so it is
      // not sent in the HTTP request target, proxy/access logs, or Referrer
      // header. Invite.tsx captures it once and removes the fragment.
      const acceptUrl = `${base}/invite#token=${encodeURIComponent(token)}`
      const emailed = await notify(c.env, {
        id: crypto.randomUUID(),
        type: 'user.invited',
        to: email,
        payload: { acceptUrl },
      })
      return c.json({ emailed, ...(emailed ? {} : { acceptUrl }) }, 201)
    },
  )

export type AppType = typeof routes

// --- helpers (module scope; not part of the RPC chain) ---

/** best-effort 通知(@app/shared の sendNotification に委譲)。 */
function notify(env: Bindings, job: NotificationJob): Promise<boolean> {
  return sendNotification(env.NOTIFIER, env.ADMIN_TO_NOTIFIER_KEY, 'admin', job)
}

/** auth_events(監査ログ)の保持日数。日次 Cron が超過分を削除する。 */
const AUTH_EVENTS_RETENTION_DAYS = 90
const LOGIN_RATE_LIMIT_CLEANUP_LIMIT = 1_000

/**
 * Hourly org reconcile (Cron) + auth_events retention. Re-syncs any
 * admin↔domain drift; notifies once per day slot. deployable domain が 0 件なら
 * reconcile を skip する。設定済み domain の binding が失敗した場合は cron を
 * throw させないが、失敗自体は通知する(照合が落ち続けるとドリフトが無限に
 * 見えなくなるため)。
 */
async function scheduled(_event: unknown, env: Bindings, _ctx?: unknown): Promise<void> {
  const db = drizzle(env.DB)

  // 監査ログの保持期間掃除。insert-only のまま放置すると攻撃的なログイン試行で
  // 無制限に育ち、D1 容量(無料枠 500MB/DB)とバックアップを圧迫する。
  try {
    const cutoff = new Date(
      Date.now() - AUTH_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()
    await db.delete(authEvents).where(lt(authEvents.createdAt, cutoff))
  } catch (err) {
    console.error('auth_events retention cleanup failed', err)
  }

  // Login spray keys are intentionally bounded per source IP, but expired
  // account buckets still need reclaiming. LIMIT keeps a single Cron run from
  // turning into an unbounded D1 delete after a sustained attack; the indexed
  // expiry predicate makes the next slot continue where this one stopped.
  try {
    const cutoff = new Date().toISOString()
    await db.run(
      sql`DELETE FROM ${loginRateLimits}
          WHERE ${loginRateLimits.expiresAt} < ${cutoff}
          LIMIT ${LOGIN_RATE_LIMIT_CLEANUP_LIMIT}`,
    )
  } catch (err) {
    console.error('login rate-limit cleanup failed', err)
  }

  try {
    for (const syncEnv of configuredDomainSyncEnvironments(env)) {
      const result = await reconcileOrgs({
        // 全行を 1 クエリで取り、resync にそのまま持ち回す(org ごとの再 SELECT = N+1
        // を避ける。全 org ドリフト時に D1 の 50 クエリ/呼 上限を踏まないため)。
        listAdminOrgs: async () => {
          const rows = await db.select().from(organizations)
          return rows.map((r) => ({
            id: r.id,
            name: r.name,
            plan: r.plan,
            isDisabled: r.isDisabled === '1',
            version: r.version,
            row: r,
          }))
        },
        listDomainOrgs: () => listDomainOrgs(syncEnv),
        resync: (o) => syncOrgToDomain(syncEnv, toOrganization(o.row)),
        notifyDrift: async ({ drift, failed, truncated }) => {
          const alertEmail = configuredAlertEmail(env)
          if (!alertEmail) {
            console.warn('sync drift detected but OPS_ALERT_EMAIL is unset', drift)
            return
          }
          // 冪等キーは日付スロット(再実行・リトライで連打しない)。
          await notify(env, {
            id: `ops.sync_drift:${syncEnv.directory}:${new Date().toISOString().slice(0, 10)}`,
            type: 'ops.sync_drift',
            to: alertEmail,
            payload: {
              domain: syncEnv.directory,
              organizationIds: drift,
              count: drift.length,
              failed,
              truncated,
            },
          })
        },
      })
      if (result.drift.length > 0) {
        console.warn(`org sync drift reconciled for ${syncEnv.directory}`, result)
      }
    }
  } catch (err) {
    // 照合そのものの失敗(ドメイン側ダウン・caller-specific key 不一致等)。ドリフト通知は
    // 照合成功時にしか出ないので、ここで通知しないと壊れた同期が永久に無音になる。
    console.error('hourly reconcile failed', err)
    const alertEmail = configuredAlertEmail(env)
    if (alertEmail) {
      await notify(env, {
        id: `ops.sync_drift:failed:${new Date().toISOString().slice(0, 10)}`,
        type: 'ops.sync_drift',
        to: alertEmail,
        payload: { reason: 'reconcile_failed', message: err instanceof Error ? err.message : '' },
      })
    }
  }
}

export default { fetch: app.fetch, scheduled }
