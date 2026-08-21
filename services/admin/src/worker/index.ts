import {
  AcceptInviteRequest,
  CreateOrganization,
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
import type { D1Database, Fetcher, KVNamespace } from '@cloudflare/workers-types'
import { zValidator } from '@hono/zod-validator'
import { desc, eq, lt } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono, type MiddlewareHandler } from 'hono'
import { except } from 'hono/combine'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { type AuthDeps, acceptInvite, login, refresh, revokeOne } from './auth/service'
import { authEvents, invitations, organizations, users } from './db/schema'
import { reconcileOrgs } from './reconcile'
import { listDomainOrgs, type SyncEnv, syncOrgToExampleService } from './sync'

// The admin SPA is served by this same Worker (same origin) — no CORS.
export type Bindings = {
  DB: D1Database
  // Rate-limit / lockout counters for login.
  AUTH_RL: KVNamespace
  // Service binding to the domain Worker (example_service): org sync + reconcile.
  EXAMPLE_SERVICE: Fetcher
  // Service binding to the notifier Worker (invite / ops mail, best-effort).
  NOTIFIER: Fetcher
  INTERNAL_KEY: string
  JWT_SECRET: string
  AUTH_PEPPER: string
  AUTH_DEV_GRANT?: string
  // 招待リンクの基底 URL の明示オーバーライド(プロキシ/カスタムドメイン用)。
  // 未設定ならリクエストの origin から導出する(/invite はこの SPA 自身が配信)。
  INVITE_BASE_URL?: string
  // 日次照合ドリフト通知の宛先(検証済み実メール)。未設定なら通知をスキップ。
  OPS_ALERT_EMAIL?: string
}

const REFRESH_COOKIE = 'rt'
const INVITE_TTL_SECONDS = 72 * 60 * 60

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>()

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('unhandled', err)
  return c.json({ error: 'internal_error' }, 500)
})

function authDeps(c: { env: Bindings }): AuthDeps {
  return {
    db: drizzle(c.env.DB),
    kv: c.env.AUTH_RL,
    pepper: c.env.AUTH_PEPPER,
    jwtSecret: c.env.JWT_SECRET,
  }
}
function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
}
function setRefreshCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: REFRESH_TTL_SECONDS,
  })
}
/** DB 行 → 契約 Organization。 */
function toOrganization(r: {
  id: string
  name: string
  plan: string
  isDisabled: string
  createdAt: string
}): Organization {
  return Organization.parse({
    id: r.id,
    name: r.name,
    plan: r.plan,
    isDisabled: r.isDisabled === '1',
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
    const orgId = c.get('auth')?.org
    if (!orgId) return c.json({ error: 'unauthorized' }, 401)
    const rows = await drizzle(c.env.DB)
      .select({ isOperator: organizations.isOperator })
      .from(organizations)
      .where(eq(organizations.id, orgId))
    if (rows[0]?.isOperator !== '1') return c.json({ error: 'operator_only' }, 403)
    await next()
  }
}

// Internal endpoints: shared-key guarded (other Workers → service binding).
app.use('/api/internal/*', internalAuth())

// Default-deny: EVERY /api/* route requires an operator-org admin JWT unless
// explicitly exempted (health / auth are public; internal has its own key
// guard above). 新ルートはミドルウェアを足し忘れても保護される。
app.use(
  '/api/*',
  except(
    ['/api/health', '/api/auth/*', '/api/internal/*'],
    tenantAuth(),
    requireRole('admin'),
    requireOperator(),
  ),
)

const routes = app
  .get('/api/health', (c) => c.json({ status: 'ok' as const }))

  // ---- Public auth API (admin SPA, same origin) ----
  // NOTE: このテンプレには「ドメイン Worker が admin へ認証をプロキシする」
  // internal auth API は置いていない(呼び出し元が無いコードは腐る)。その構成に
  // する fork は、この public ルート群と同じ auth/service.ts の関数を
  // /api/internal/auth/* として薄く公開すればよい(cookie 化を境界側で行う)。
  .post('/api/auth/login', zValidator('json', LoginRequest), async (c) => {
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
      if (!out.keepCookie) deleteCookie(c, REFRESH_COOKIE, { path: '/' })
      return c.json({ error: out.error }, out.status)
    }
    setRefreshCookie(c, out.response.refreshToken)
    return c.json({ token: out.response.token }, 200)
  })
  .post('/api/auth/logout', async (c) => {
    const rt = getCookie(c, REFRESH_COOKIE)
    if (rt) await revokeOne(authDeps(c), rt)
    deleteCookie(c, REFRESH_COOKIE, { path: '/' })
    return c.json({ ok: true as const })
  })
  // Public invite acceptance (the admin SPA hosts the /invite route). Sets the
  // refresh cookie like login and returns the same body (without refreshToken).
  .post('/api/auth/accept-invite', zValidator('json', AcceptInviteRequest), async (c) => {
    const out = await acceptInvite(authDeps(c), c.req.valid('json'))
    if (!out.ok) return c.json({ error: out.error }, out.status)
    setRefreshCookie(c, out.response.refreshToken)
    const { refreshToken: _omit, ...body } = out.response
    return c.json(body, 200)
  })
  // DEV-ONLY grant: mints an admin JWT with no credential check. Fail-closed
  // unless AUTH_DEV_GRANT === 'true'. Never enable in prod (docs/howto/deploy.md).
  .post('/api/auth/token', zValidator('json', IssueTokenRequest), async (c) => {
    if (c.env.AUTH_DEV_GRANT !== 'true') return c.json({ error: 'not_found' }, 404)
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
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing({ target: organizations.id })
    const token = await signAccessToken(
      { sub: `dev:${organizationId}`, org: organizationId, email, role },
      c.env.JWT_SECRET,
    )
    return c.json({ token })
  })

  // ---- Organizations (operator-admin only, via the default-deny gate) ----
  .get('/api/organizations', async (c) => {
    const db = drizzle(c.env.DB)
    const rows = await db.select().from(organizations).orderBy(desc(organizations.createdAt))
    return c.json(rows.map(toOrganization))
  })
  .post(
    '/api/organizations',
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
        createdAt: new Date().toISOString(),
      }
      await db.insert(organizations).values(org)
      // Reconcile into the domain D1 via the typed service binding (best-effort).
      // 結果は `synced` で応答に載せる — 失敗を握りつぶすと、無効化やプラン変更が
      // ドメイン側に届いていないことに次の日次照合までオペレータが気づけない。
      const synced = await syncOrgToExampleService(c.env, toOrganization(org))
      return c.json({ ...toOrganization(org), synced }, 201)
    },
  )
  .patch(
    '/api/organizations/:id',
    zValidator(
      'json',
      z.object({ plan: Plan.optional(), isDisabled: z.boolean().optional() }).strict(),
    ),
    async (c) => {
      const db = drizzle(c.env.DB)
      const id = c.req.param('id')
      const patch = c.req.valid('json')
      // 1 クエリで更新 + 更新後行の取得(SELECT→UPDATE の 2 往復と読み書き競合を防ぐ)。
      const set: Record<string, string> = {}
      if (patch.plan !== undefined) set.plan = patch.plan
      if (patch.isDisabled !== undefined) set.isDisabled = patch.isDisabled ? '1' : '0'
      if (Object.keys(set).length === 0) {
        const rows = await db.select().from(organizations).where(eq(organizations.id, id))
        return rows[0] ? c.json(toOrganization(rows[0])) : c.json({ error: 'not_found' }, 404)
      }
      const updated = await db
        .update(organizations)
        .set(set)
        .where(eq(organizations.id, id))
        .returning()
      const row = updated[0]
      if (!row) return c.json({ error: 'not_found' }, 404)
      const merged = toOrganization(row)
      const synced = await syncOrgToExampleService(c.env, merged)
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
      .set({ isDisabled: '1' })
      .where(eq(organizations.id, id))
      .returning()
    const row = updated[0]
    if (!row) return c.json({ error: 'not_found' }, 404)
    // synced=false は「admin では無効化済みだがドメイン側はまだ有効」— 次の日次照合
    // までその org の API アクセスが生き残ることを意味する。UI が警告を出せるよう返す。
    const synced = await syncOrgToExampleService(c.env, toOrganization(row))
    return c.json({ id, isDisabled: true as const, synced })
  })
  // Invite a user (staff by default) to an org: user(hash=null) + invitation +
  // best-effort notify. On notify failure, return the link for manual delivery.
  .post(
    '/api/organizations/:id/invitations',
    // 契約は Zod 単一ソース(@app/contracts の InviteRequest)— インラインで
    // 二重定義しない。
    zValidator('json', InviteRequest),
    async (c) => {
      const db = drizzle(c.env.DB)
      const orgId = c.req.param('id')
      const { email, role } = c.req.valid('json')
      const orgRows = await db.select().from(organizations).where(eq(organizations.id, orgId))
      if (!orgRows[0]) return c.json({ error: 'not_found' }, 404)

      const now = new Date()
      const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase()))
      // クロステナント防御: 別 org に既存の email は招待できない(受諾時に他 org
      // ユーザーのパスワードを上書きする乗っ取り経路になるため)。同 org は再招待扱い。
      if (existing[0] && existing[0].organizationId !== orgId) {
        return c.json({ error: 'email_taken' }, 409)
      }

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
      // Create the pending user only if this email is new (re-invite reuses it).
      const userStmt = existing[0]
        ? undefined
        : db.insert(users).values({
            id: crypto.randomUUID(),
            organizationId: orgId,
            email: email.toLowerCase(),
            passwordHash: null,
            role,
            createdAt: now.toISOString(),
          })
      await db.batch(userStmt ? [inviteStmt, userStmt] : [inviteStmt])

      // The acceptance page (/invite) is hosted by this admin SPA, so the
      // request origin is always a correct base. INVITE_BASE_URL is an explicit
      // override for proxy/custom-domain setups(localhost へのフォールバックは
      // 本番でデッドリンクを配る事故になるので置かない)。
      const base = c.env.INVITE_BASE_URL || new URL(c.req.url).origin
      const acceptUrl = `${base}/invite?token=${token}`
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
  return sendNotification(env.NOTIFIER, env.INTERNAL_KEY, job)
}

/** auth_events(監査ログ)の保持日数。日次 Cron が超過分を削除する。 */
const AUTH_EVENTS_RETENTION_DAYS = 90

/**
 * Daily org reconcile (Cron) + auth_events retention. Re-syncs any
 * admin↔domain drift; notifies once per day slot. reconcile 部分は try/catch —
 * ドメイン Worker 未デプロイ等でリストが取れないトポロジ(雛形を実サービスへ
 * 差し替える前)でも cron を throw させないが、失敗自体は通知する(照合が
 * 落ち続けるとドリフトが無限に見えなくなるため)。
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

  try {
    const syncEnv: SyncEnv = {
      EXAMPLE_SERVICE: env.EXAMPLE_SERVICE,
      INTERNAL_KEY: env.INTERNAL_KEY,
    }
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
          row: r,
        }))
      },
      listDomainOrgs: () => listDomainOrgs(syncEnv),
      resync: (o) => syncOrgToExampleService(syncEnv, toOrganization(o.row)),
      notifyDrift: async ({ drift, failed, truncated }) => {
        if (!env.OPS_ALERT_EMAIL) {
          console.warn('sync drift detected but OPS_ALERT_EMAIL is unset', drift)
          return
        }
        // 冪等キーは日次スロット(再実行・リトライで連打しない)。
        await notify(env, {
          id: `ops.sync_drift:${new Date().toISOString().slice(0, 10)}`,
          type: 'ops.sync_drift',
          to: env.OPS_ALERT_EMAIL,
          payload: { organizationIds: drift, count: drift.length, failed, truncated },
        })
      },
    })
    if (result.drift.length > 0) console.warn('org sync drift reconciled', result)
  } catch (err) {
    // 照合そのものの失敗(ドメイン側ダウン・INTERNAL_KEY 不一致等)。ドリフト通知は
    // 照合成功時にしか出ないので、ここで通知しないと壊れた同期が永久に無音になる。
    console.error('daily reconcile failed', err)
    if (env.OPS_ALERT_EMAIL) {
      await notify(env, {
        id: `ops.sync_drift:failed:${new Date().toISOString().slice(0, 10)}`,
        type: 'ops.sync_drift',
        to: env.OPS_ALERT_EMAIL,
        payload: { reason: 'reconcile_failed', message: err instanceof Error ? err.message : '' },
      })
    }
  }
}

export default { fetch: app.fetch, scheduled }
