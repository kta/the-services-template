/**
 * サーバ側 認証・テナンシー ミドルウェア。
 *
 * 全サービス共通の hono ミドルウェア群。org 行の解決だけはドメインごとに違う
 * (admin はローカル、他ドメインは同期コピー)ため resolver を注入する。
 * **plan はここで org 行から読む**(クレームに入れず毎リクエスト参照 = 即時反映)。
 */
import {
  ACCESS_TOKEN_AUDIENCE,
  type AccessTokenAudience,
  AuthSessionCheckRequest,
  AuthSessionStatus,
  type Plan,
  type Role,
} from '@app/contracts'
import type { Fetcher } from '@cloudflare/workers-types'
import type { Context, MiddlewareHandler } from 'hono'
import { verifyAccessToken } from './jwt'

/** tenantAuth が set する context 変数。アプリは Variables にこれを含める。 */
export type AuthVariables = {
  auth: { sub: string; org: string; email: string; role: Role; sid?: string }
  org?: { plan: Plan; isDisabled: boolean }
}

/** 現在の org(組織)行の解決結果。行不在 = 未同期。 */
export type OrgRow = { plan: Plan; isDisabled: boolean } | null
export type OrgResolver = (orgId: string, c: Context) => Promise<OrgRow>

type Env = { Bindings: { JWT_PUBLIC_KEY: string }; Variables: AuthVariables }
type AuthClock = number | (() => number)

export type DomainSessionBindings = {
  JWT_PUBLIC_KEY: string
  APP_ENV?: string
  AUTH_DEV_GRANT?: string
  ADMIN?: Fetcher
  DOMAIN_TO_ADMIN_KEY?: string
}

export type DomainSessionEnv = {
  Bindings: DomainSessionBindings
  Variables: AuthVariables
}

function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return null
  return h.slice('Bearer '.length).trim() || null
}

/**
 * access JWT を検証し `c.var.auth` を確立。無 / 不正 / 期限切れは 401。
 * これ以降のミドルウェア/ハンドラは `c.var.auth.org` でテナントスコープする。
 */
export function tenantAuth(
  now?: AuthClock,
  audience: AccessTokenAudience = ACCESS_TOKEN_AUDIENCE,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = bearer(c)
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    // Resolve the default clock inside the request handler. Worker modules stay
    // warm across requests; evaluating Date.now() while constructing the
    // middleware would let an expired access token survive for the isolate's
    // lifetime. A number/function remains injectable for deterministic tests.
    const verificationNow =
      typeof now === 'function' ? now() : (now ?? Math.floor(Date.now() / 1000))
    const payload = await verifyAccessToken(token, c.env.JWT_PUBLIC_KEY, verificationNow, audience)
    if (!payload) return c.json({ error: 'unauthorized' }, 401)
    c.set('auth', {
      sub: payload.sub,
      org: payload.org,
      email: payload.email,
      role: payload.role,
      sid: payload.sid,
    })
    await next()
  }
}

/**
 * Domain-only live-session gate. Signature/audience verification proves that
 * admin issued the token; the admin service-binding check proves that its
 * refresh session is still active and that the current user/org is valid.
 * Domain Workers deliberately do not get the admin D1 or JWT private key.
 * Any missing binding, malformed response, non-2xx response, or timeout is a
 * 503 fail-closed result rather than a temporary authorization bypass.
 *
 * The explicit development grant is the only exception. It exists because a
 * local Miniflare domain has no admin service binding; production config cannot
 * enable this path (`AUTH_DEV_GRANT` is false/unset there).
 */
export function requireLiveDomainSession(): MiddlewareHandler<DomainSessionEnv> {
  return async (c, next) => {
    const auth = c.get('auth')
    if (c.env.APP_ENV === 'development' && c.env.AUTH_DEV_GRANT === 'true') {
      await next()
      return
    }
    if (!auth?.sid) return c.json({ error: 'unauthorized' }, 401)

    const admin = c.env.ADMIN
    const internalKey = c.env.DOMAIN_TO_ADMIN_KEY
    if (!admin || !internalKey) return c.json({ error: 'auth_unavailable' }, 503)

    try {
      const response = await admin.fetch('http://admin/api/internal/auth/session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': internalKey,
          'x-internal-caller': 'domain',
        },
        body: JSON.stringify(
          AuthSessionCheckRequest.parse({ sid: auth.sid, sub: auth.sub, org: auth.org }),
        ),
        signal: AbortSignal.timeout(2_000) as never,
      })
      if (!response.ok) return c.json({ error: 'auth_unavailable' }, 503)
      const status = AuthSessionStatus.safeParse(await response.json())
      if (!status.success) return c.json({ error: 'auth_unavailable' }, 503)
      if (!status.data.active || !status.data.role) {
        return c.json({ error: 'unauthorized' }, 401)
      }
      c.set('auth', { ...auth, role: status.data.role })
      await next()
    } catch {
      return c.json({ error: 'auth_unavailable' }, 503)
    }
  }
}

/**
 * org 同期行を解決して `c.var.org` に載せる。行不在は 503 `not_synced`
 * (無効化 403 と区別 — リトライで回復し得る一時状態)、無効化は 403 `org_disabled`。
 * tenantAuth の後段に置く。
 */
export function requireActiveOrg(resolve: OrgResolver): MiddlewareHandler<Env> {
  return async (c, next) => {
    const org = c.get('auth')?.org
    if (!org) return c.json({ error: 'unauthorized' }, 401)
    const row = await resolve(org, c)
    if (!row) return c.json({ error: 'not_synced' }, 503)
    if (row.isDisabled) return c.json({ error: 'org_disabled' }, 403)
    c.set('org', row)
    await next()
  }
}

/** 指定ロールを要求。満たさなければ 403。tenantAuth の後段。 */
export function requireRole(role: Role): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.get('auth')?.role !== role) return c.json({ error: 'forbidden' }, 403)
    await next()
  }
}

/**
 * 指定プランを要求。requireActiveOrg の後段(c.var.org が必要)。
 * role による免除はしない — JWT の role==='admin' は**テナント管理者**も含む
 * (プラットフォーム運営者ではない)ため、admin を pass させると free プランの
 * org でも管理者ユーザー経由で課金機能が素通りになる。
 */
export function requirePlan(plan: Plan): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.get('org')?.plan !== plan) return c.json({ error: 'plan_required' }, 403)
    await next()
  }
}
