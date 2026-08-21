/**
 * サーバ側 認証・テナンシー ミドルウェア。
 *
 * 全サービス共通の hono ミドルウェア群。org 行の解決だけはドメインごとに違う
 * (admin はローカル、他ドメインは同期コピー)ため resolver を注入する。
 * **plan はここで org 行から読む**(クレームに入れず毎リクエスト参照 = 即時反映)。
 */
import type { Plan, Role } from '@app/contracts'
import type { Context, MiddlewareHandler } from 'hono'
import { verifyAccessToken } from './jwt'

/** tenantAuth が set する context 変数。アプリは Variables にこれを含める。 */
export type AuthVariables = {
  auth: { sub: string; org: string; email: string; role: Role }
  org?: { plan: Plan; isDisabled: boolean }
}

/** 現在の org(組織)行の解決結果。行不在 = 未同期。 */
export type OrgRow = { plan: Plan; isDisabled: boolean } | null
export type OrgResolver = (orgId: string, c: Context) => Promise<OrgRow>

type Env = { Bindings: { JWT_SECRET: string }; Variables: AuthVariables }

function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return null
  return h.slice('Bearer '.length).trim() || null
}

/**
 * access JWT を検証し `c.var.auth` を確立。無 / 不正 / 期限切れは 401。
 * これ以降のミドルウェア/ハンドラは `c.var.auth.org` でテナントスコープする。
 */
export function tenantAuth(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = bearer(c)
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    const payload = await verifyAccessToken(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'unauthorized' }, 401)
    c.set('auth', {
      sub: payload.sub,
      org: payload.org,
      email: payload.email,
      role: payload.role,
    })
    await next()
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
