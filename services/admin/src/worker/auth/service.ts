/**
 * 認証コアロジック。
 *
 * hono から切り離した純度の高い関数群。public(/api/auth/*)ルートがこれを呼ぶ。
 * 副作用は D1 と KV のみで、cookie 化は呼び出し側(ルート)の責務。
 */
import type { LoginResponse, RefreshResponse, Role } from '@app/contracts'
import {
  ACCESS_TTL_SECONDS,
  generateRefreshToken,
  hashStretched,
  hashToken,
  REFRESH_TTL_SECONDS,
  signAccessToken,
  verifyStretched,
} from '@app/shared'
import type { KVNamespace } from '@cloudflare/workers-types'
import { and, eq, isNull, lt } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { authEvents, invitations, organizations, refreshTokens, users } from '../db/schema'

type Db = DrizzleD1Database<Record<string, never>>

type AuthConfig = {
  pepper: string
  jwtSecret: string
  /** テスト用の固定時刻(秒)。未指定なら実時刻。 */
  now?: number
}

export type AuthDeps = { db: Db; kv: KVNamespace } & AuthConfig

/** ログイン試行のロックアウト閾値 / ウィンドウ。 */
export const MAX_LOGIN_FAILURES = 5
export const LOCKOUT_WINDOW_SECONDS = 15 * 60

/**
 * 多タブ同時 refresh の猶予(秒)。複数タブが同じ cookie で並行 refresh すると、
 * 負けた側は「ローテーション直後の旧トークン」を提示する。これを即・盗難扱い
 * (全セッション revoke)にすると通常のマルチタブ利用でユーザー全体が強制ログアウト
 * されるため、後継発行から短い猶予内の再提示は 401 のみで返す。
 */
export const ROTATION_GRACE_SECONDS = 30

type Fail = {
  ok: false
  status: 400 | 401 | 403 | 404 | 410 | 429
  error: string
  retryAfter?: number
  /**
   * true = cookie を消さずに返す(マルチタブ競合の負け側)。ブラウザの cookie は
   * 勝者の Set-Cookie で既に新トークンに置き換わっており、ここで削除応答を返すと
   * 有効な新 cookie を巻き添えで消してしまう。
   */
  keepCookie?: boolean
}
export type LoginOutcome = { ok: true; response: LoginResponse } | Fail
export type RefreshOutcome = { ok: true; response: RefreshResponse } | Fail
export type AcceptOutcome = { ok: true; response: LoginResponse } | Fail

function nowSec(deps: AuthDeps): number {
  return deps.now ?? Math.floor(Date.now() / 1000)
}
function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString()
}

async function recordEvent(
  deps: AuthDeps,
  e: { organizationId: string | null; email: string; kind: string; ip?: string | null },
): Promise<void> {
  await deps.db.insert(authEvents).values({
    id: crypto.randomUUID(),
    organizationId: e.organizationId,
    email: e.email,
    kind: e.kind,
    ip: e.ip ?? null,
    createdAt: isoFromSec(nowSec(deps)),
  })
}

type OrgRow = { id: string; name: string; plan: string; isDisabled: string }
type UserRow = {
  id: string
  organizationId: string
  email: string
  passwordHash: string | null
  role: string
}

async function loadUserByEmail(deps: AuthDeps, email: string): Promise<UserRow | undefined> {
  const rows = await deps.db.select().from(users).where(eq(users.email, email))
  return rows[0] as UserRow | undefined
}
async function loadUserById(deps: AuthDeps, id: string): Promise<UserRow | undefined> {
  const rows = await deps.db.select().from(users).where(eq(users.id, id))
  return rows[0] as UserRow | undefined
}
async function loadOrg(deps: AuthDeps, id: string): Promise<OrgRow | undefined> {
  const rows = await deps.db.select().from(organizations).where(eq(organizations.id, id))
  return rows[0] as OrgRow | undefined
}

/**
 * access JWT + 新しい refresh トークンを発行し、refresh を DB に保存する。
 * login と accept-invite が共有。返り値の refreshToken は平文(以降は保存しない)。
 */
async function issueSession(deps: AuthDeps, user: UserRow, org: OrgRow): Promise<LoginResponse> {
  const sec = nowSec(deps)
  const token = await signAccessToken(
    { sub: user.id, org: user.organizationId, email: user.email, role: user.role as Role },
    deps.jwtSecret,
    ACCESS_TTL_SECONDS,
    sec,
  )
  const refreshToken = generateRefreshToken()
  await deps.db.insert(refreshTokens).values({
    id: crypto.randomUUID(),
    userId: user.id,
    organizationId: user.organizationId,
    tokenHash: await hashToken(refreshToken),
    expiresAt: isoFromSec(sec + REFRESH_TTL_SECONDS),
    rotatedTo: null,
    revokedAt: null,
    createdAt: isoFromSec(sec),
  })
  return {
    token,
    refreshToken,
    user: { id: user.id, email: user.email, role: user.role as Role },
    organization: {
      id: org.id,
      name: org.name,
      plan: org.plan as LoginResponse['organization']['plan'],
      isDisabled: org.isDisabled === '1',
    },
  }
}

/**
 * ログイン。email+IP で失敗回数を KV でカウントし 5 回でロックアウト(429)。
 * 成功でカウンタ解除。stretched(クライアント PBKDF2 出力)を pepper HMAC 照合。
 */
export async function login(
  deps: AuthDeps,
  input: { email: string; stretched: string; ip?: string },
): Promise<LoginOutcome> {
  const email = input.email.toLowerCase()
  const ip = input.ip ?? 'unknown'
  const rlKey = `rl:login:${email}:${ip}`
  const failures = Number(await deps.kv.get(rlKey)) || 0
  if (failures >= MAX_LOGIN_FAILURES) {
    await recordEvent(deps, { organizationId: null, email, kind: 'lockout', ip })
    return {
      ok: false,
      status: 429,
      error: 'too_many_requests',
      retryAfter: LOCKOUT_WINDOW_SECONDS,
    }
  }

  const bump = async () => {
    await deps.kv.put(rlKey, String(failures + 1), { expirationTtl: LOCKOUT_WINDOW_SECONDS })
  }

  const user = await loadUserByEmail(deps, email)
  if (!user?.passwordHash) {
    await bump()
    await recordEvent(deps, {
      organizationId: user?.organizationId ?? null,
      email,
      kind: 'login_failure',
      ip,
    })
    return { ok: false, status: 401, error: 'invalid_credentials' }
  }
  const org = await loadOrg(deps, user.organizationId)
  const ok = await verifyStretched(input.stretched, deps.pepper, user.passwordHash)
  if (!ok || !org) {
    await bump()
    await recordEvent(deps, {
      organizationId: user.organizationId,
      email,
      kind: 'login_failure',
      ip,
    })
    return { ok: false, status: 401, error: 'invalid_credentials' }
  }
  // org_disabled は**パスワード検証成功の後**にだけ返す。検証前に返すと、失敗
  // カウントも増えない 403 が無効テナントのメール列挙オラクルになるため。
  // この 403 でもカウンタは増やす — ここだけ bump しないと、無効 org の有効資格
  // 情報を持つ相手にレート制限のかからない probe 経路を残すことになる。
  if (org.isDisabled === '1') {
    await bump()
    await recordEvent(deps, { organizationId: org.id, email, kind: 'login_failure', ip })
    return { ok: false, status: 403, error: 'org_disabled' }
  }

  // KV write は無料枠(1,000/日)を食うので、カウンタがあるときだけ消す。
  if (failures > 0) await deps.kv.delete(rlKey)
  await recordEvent(deps, { organizationId: org.id, email, kind: 'login_success', ip })
  return { ok: true, response: await issueSession(deps, user, org) }
}

/** そのユーザーの未失効 refresh を全て revoke(再利用検知・明示ログアウト時)。 */
async function revokeAllForUser(deps: AuthDeps, userId: string): Promise<void> {
  await deps.db
    .update(refreshTokens)
    .set({ revokedAt: isoFromSec(nowSec(deps)) })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
}

/**
 * refresh ローテーション。使用済み(rotatedTo あり)/ revoke 済みの再提示は
 * 盗難とみなし、当該ユーザーの全 refresh を revoke(再利用検知)。
 */
export async function refresh(
  deps: AuthDeps,
  input: { refreshToken: string },
): Promise<RefreshOutcome> {
  const hash = await hashToken(input.refreshToken)
  const rows = await deps.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash))
  const row = rows[0]
  if (!row) return { ok: false, status: 401, error: 'invalid_token' }

  if (row.revokedAt || row.rotatedTo) {
    // 猶予内(直近ローテーションの直後)の rotated 再提示はマルチタブ競合として
    // 401 のみ返す(revoke しない)。猶予を過ぎた再提示は盗難とみなし全 revoke。
    // revoke 済みトークンの再提示に猶予はない(明示ログアウト後の利用は常に異常)。
    if (!row.revokedAt && row.rotatedTo) {
      const successors = await deps.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, row.rotatedTo))
      const rotatedAt = successors[0] ? new Date(successors[0].createdAt).getTime() / 1000 : 0
      if (nowSec(deps) - rotatedAt <= ROTATION_GRACE_SECONDS) {
        return { ok: false, status: 401, error: 'rotation_race', keepCookie: true }
      }
    }
    await revokeAllForUser(deps, row.userId)
    const u = await loadUserById(deps, row.userId)
    await recordEvent(deps, {
      organizationId: row.organizationId,
      email: u?.email ?? 'unknown',
      kind: 'refresh_reuse',
    })
    return { ok: false, status: 401, error: 'token_reuse' }
  }

  const sec = nowSec(deps)
  if (new Date(row.expiresAt).getTime() / 1000 < sec) {
    return { ok: false, status: 401, error: 'expired_token' }
  }

  const user = await loadUserById(deps, row.userId)
  const org = user ? await loadOrg(deps, user.organizationId) : undefined
  if (!user || !org) return { ok: false, status: 401, error: 'invalid_token' }
  if (org.isDisabled === '1') return { ok: false, status: 403, error: 'org_disabled' }

  const newToken = generateRefreshToken()
  const newId = crypto.randomUUID()
  const accessToken = await signAccessToken(
    { sub: user.id, org: user.organizationId, email: user.email, role: user.role as Role },
    deps.jwtSecret,
    ACCESS_TTL_SECONDS,
    sec,
  )
  await deps.db.batch([
    deps.db.insert(refreshTokens).values({
      id: newId,
      userId: user.id,
      organizationId: user.organizationId,
      tokenHash: await hashToken(newToken),
      expiresAt: isoFromSec(sec + REFRESH_TTL_SECONDS),
      rotatedTo: null,
      revokedAt: null,
      createdAt: isoFromSec(sec),
    }),
    deps.db.update(refreshTokens).set({ rotatedTo: newId }).where(eq(refreshTokens.id, row.id)),
    // 掃除: 期限切れ行はもう再利用検知に寄与しない(期限チェックが先に 401 を
    // 返す)ので、ローテーションのついでに削除する。放置するとテーブルが refresh
    // のたび無限に育ち、認証ホットパスの rows_read(無料枠 5M/日)を食い潰す。
    deps.db
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.userId, user.id), lt(refreshTokens.expiresAt, isoFromSec(sec)))),
  ])
  return { ok: true, response: { token: accessToken, refreshToken: newToken } }
}

/** 招待受諾(パスワード設定 → セッション発行)。期限切れ/消費済みは 410。 */
export async function acceptInvite(
  deps: AuthDeps,
  input: { token: string; email: string; stretched: string },
): Promise<AcceptOutcome> {
  const hash = await hashToken(input.token)
  const rows = await deps.db.select().from(invitations).where(eq(invitations.tokenHash, hash))
  const inv = rows[0]
  if (!inv) return { ok: false, status: 404, error: 'invite_not_found' }
  const sec = nowSec(deps)
  if (inv.consumedAt || new Date(inv.expiresAt).getTime() / 1000 < sec) {
    return { ok: false, status: 410, error: 'invite_expired' }
  }
  // email は stretch の salt。招待と違う email で受諾させると「別 salt のハッシュ」が
  // 保存され、正しい email での以後のログインが black-box に失敗し続ける(実質
  // アカウント破壊)。typo をここで検出して差し戻す。
  if (input.email.toLowerCase() !== inv.email.toLowerCase()) {
    return { ok: false, status: 400, error: 'email_mismatch' }
  }
  const user = await loadUserByEmail(deps, inv.email.toLowerCase())
  if (!user) return { ok: false, status: 404, error: 'user_not_found' }
  // クロステナント防御: 招待の org とユーザーの所属 org が一致しない招待は
  // 受諾させない(他 org 既存ユーザーのパスワード上書き = アカウント乗っ取り防止)。
  if (user.organizationId !== inv.organizationId) {
    return { ok: false, status: 410, error: 'invite_expired' }
  }
  const org = await loadOrg(deps, user.organizationId)
  if (!org) return { ok: false, status: 404, error: 'org_not_found' }
  if (org.isDisabled === '1') return { ok: false, status: 403, error: 'org_disabled' }

  const passwordHash = await hashStretched(input.stretched, deps.pepper)
  await deps.db.batch([
    deps.db.update(users).set({ passwordHash }).where(eq(users.id, user.id)),
    deps.db
      .update(invitations)
      .set({ consumedAt: isoFromSec(sec) })
      .where(eq(invitations.id, inv.id)),
  ])
  await recordEvent(deps, { organizationId: org.id, email: user.email, kind: 'invite_accepted' })
  return { ok: true, response: await issueSession(deps, { ...user, passwordHash }, org) }
}

/** cookie の refresh を 1 本だけ revoke(単一端末ログアウト)。 */
export async function revokeOne(deps: AuthDeps, refreshToken: string): Promise<void> {
  const hash = await hashToken(refreshToken)
  await deps.db
    .update(refreshTokens)
    .set({ revokedAt: isoFromSec(nowSec(deps)) })
    .where(eq(refreshTokens.tokenHash, hash))
}
