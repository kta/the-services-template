/**
 * 認証コアロジック。
 *
 * hono から切り離した純度の高い関数群。public(/api/auth/*)ルートがこれを呼ぶ。
 * 副作用は D1 のみで、cookie 化は呼び出し側(ルート)の責務。
 */
import {
  type AuthSessionCheckRequest,
  type AuthSessionStatus,
  type LoginResponse,
  type RefreshResponse,
  Role,
} from '@app/contracts'
import {
  ACCESS_TTL_SECONDS,
  generateRefreshToken,
  hashStretched,
  hashToken,
  REFRESH_TTL_SECONDS,
  signAccessToken,
  verifyStretched,
} from '@app/shared'
import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  authEvents,
  invitations,
  loginRateLimits,
  organizations,
  refreshTokens,
  users,
} from '../db/schema'

type Db = DrizzleD1Database<Record<string, never>>

type AuthConfig = {
  pepper: string
  jwtPrivateKey: string
  /** テスト用の固定時刻(秒)。未指定なら実時刻。 */
  now?: number
}

export type AuthDeps = { db: Db } & AuthConfig

/** ログイン試行のロックアウト閾値 / ウィンドウ。 */
export const MAX_LOGIN_FAILURES = 5
export const LOCKOUT_WINDOW_SECONDS = 15 * 60
// A second, IP-scoped bucket prevents an attacker from creating an unbounded
// number of email+IP rows with syntactically valid throw-away addresses.
// It is deliberately much higher than the per-account lockout threshold so a
// shared office/NAT address is not locked out by a handful of bad passwords.
const MAX_LOGIN_ATTEMPTS_PER_IP = 1_000

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

/**
 * Check the live state behind an access token presented to a domain Worker.
 * The domain never gets this D1 or the JWT private key; it sends only the
 * already verified `sid`/`sub`/`org` tuple over its caller-specific binding.
 */
export async function liveSessionStatus(
  deps: AuthDeps,
  input: AuthSessionCheckRequest,
): Promise<AuthSessionStatus> {
  const now = isoFromSec(nowSec(deps))
  const sessions = await deps.db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.id, input.sid),
        eq(refreshTokens.userId, input.sub),
        eq(refreshTokens.organizationId, input.org),
        isNull(refreshTokens.revokedAt),
        isNull(refreshTokens.rotatedTo),
        sql`${refreshTokens.expiresAt} > ${now}`,
      ),
    )
    .limit(1)
  if (!sessions[0]) return { active: false, role: null }

  const user = await loadUserById(deps, input.sub)
  const org = await loadOrg(deps, input.org)
  const role = user ? Role.safeParse(user.role) : null
  if (!user?.passwordHash) {
    return { active: false, role: null }
  }
  if (user.organizationId !== input.org || !org || org.isDisabled !== '0' || !role?.success) {
    return { active: false, role: null }
  }
  return { active: true, role: role.data }
}

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

async function reserveLoginBucket(
  deps: AuthDeps,
  key: string,
  now: string,
  expiresAt: string,
  maxFailures: number,
): Promise<number> {
  const reservation = await deps.db
    .insert(loginRateLimits)
    .values({ key, failures: 1, expiresAt })
    .onConflictDoUpdate({
      target: loginRateLimits.key,
      set: {
        failures: sql`CASE
          WHEN ${loginRateLimits.expiresAt} <= ${now} THEN 1
          WHEN ${loginRateLimits.failures} < ${maxFailures}
            THEN ${loginRateLimits.failures} + 1
          ELSE ${maxFailures + 1}
        END`,
        expiresAt: sql`CASE
          WHEN ${loginRateLimits.expiresAt} <= ${now} THEN ${expiresAt}
          ELSE ${loginRateLimits.expiresAt}
        END`,
      },
    })
    .returning({ failures: loginRateLimits.failures })
  return reservation[0]?.failures ?? maxFailures + 1
}

/**
 * access JWT + 新しい refresh トークンを発行し、refresh を DB に保存する。
 * login と accept-invite が共有。返り値の refreshToken は平文(以降は保存しない)。
 */
async function issueSession(deps: AuthDeps, user: UserRow, org: OrgRow): Promise<LoginResponse> {
  const sec = nowSec(deps)
  const refreshId = crypto.randomUUID()
  const token = await signAccessToken(
    {
      sub: user.id,
      org: user.organizationId,
      email: user.email,
      role: user.role as Role,
      sid: refreshId,
    },
    deps.jwtPrivateKey,
    ACCESS_TTL_SECONDS,
    sec,
  )
  const refreshToken = generateRefreshToken()
  await deps.db.insert(refreshTokens).values({
    id: refreshId,
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
 * ログイン。email+IP の試行予約を D1 の UPSERT で原子的にカウントし、5 回を
 * 超えたらロックアウト(429)。KV の get→put では並行リクエストが閾値を回避する
 * ため使わない。成功で CAS 的にカウンタを解除する。
 */
export async function login(
  deps: AuthDeps,
  input: { email: string; stretched: string; ip?: string },
): Promise<LoginOutcome> {
  const email = input.email.toLowerCase()
  const ip = input.ip ?? 'unknown'
  const sec = nowSec(deps)
  const now = isoFromSec(sec)
  const expiresAt = isoFromSec(sec + LOCKOUT_WINDOW_SECONDS)
  // Do not persist the email/IP pair itself. Each insert-on-conflict update is
  // a single SQLite statement, so parallel requests receive distinct counters.
  // The IP bucket bounds how many account-specific rows one source can create
  // during a window, even when it rotates through unique email addresses.
  const ipKey = await hashToken(`login-ip:${ip}`)
  const ipAttempts = await reserveLoginBucket(
    deps,
    ipKey,
    now,
    expiresAt,
    MAX_LOGIN_ATTEMPTS_PER_IP,
  )
  if (ipAttempts > MAX_LOGIN_ATTEMPTS_PER_IP) {
    await recordEvent(deps, { organizationId: null, email, kind: 'ip_lockout', ip })
    return {
      ok: false,
      status: 429,
      error: 'too_many_requests',
      retryAfter: LOCKOUT_WINDOW_SECONDS,
    }
  }

  const rlKey = await hashToken(`login:${email}:${ip}`)
  const failures = await reserveLoginBucket(deps, rlKey, now, expiresAt, MAX_LOGIN_FAILURES)
  if (failures > MAX_LOGIN_FAILURES) {
    await recordEvent(deps, { organizationId: null, email, kind: 'lockout', ip })
    return {
      ok: false,
      status: 429,
      error: 'too_many_requests',
      retryAfter: LOCKOUT_WINDOW_SECONDS,
    }
  }

  const user = await loadUserByEmail(deps, email)
  if (!user?.passwordHash) {
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
    await recordEvent(deps, { organizationId: org.id, email, kind: 'login_failure', ip })
    return { ok: false, status: 403, error: 'org_disabled' }
  }

  // A concurrent failure may have advanced the counter after this request's
  // reservation. Delete only when it is still our value; never erase a newer
  // failed-attempt record.
  await deps.db
    .delete(loginRateLimits)
    .where(and(eq(loginRateLimits.key, rlKey), eq(loginRateLimits.failures, failures)))
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
  if (new Date(row.expiresAt).getTime() / 1000 <= sec) {
    return { ok: false, status: 401, error: 'expired_token' }
  }

  const user = await loadUserById(deps, row.userId)
  const org = user ? await loadOrg(deps, user.organizationId) : undefined
  if (!user || !org) return { ok: false, status: 401, error: 'invalid_token' }
  if (org.isDisabled === '1') return { ok: false, status: 403, error: 'org_disabled' }

  const newToken = generateRefreshToken()
  const newId = crypto.randomUUID()
  const accessToken = await signAccessToken(
    {
      sub: user.id,
      org: user.organizationId,
      email: user.email,
      role: user.role as Role,
      sid: newId,
    },
    deps.jwtPrivateKey,
    ACCESS_TTL_SECONDS,
    sec,
  )
  const successorTokenHash = await hashToken(newToken)
  // The compare-and-set update is deliberately the first statement. D1
  // serializes the batch transaction: exactly one concurrent caller can mark
  // the old row with its own successor id. The insert then checks that marker,
  // so a loser cannot leave an orphan successor row behind.
  const results = await deps.db.batch([
    deps.db
      .update(refreshTokens)
      .set({ rotatedTo: newId })
      .where(
        and(
          eq(refreshTokens.id, row.id),
          isNull(refreshTokens.rotatedTo),
          isNull(refreshTokens.revokedAt),
        ),
      ),
    deps.db.insert(refreshTokens).select(
      sql`
        SELECT ${newId}, ${user.id}, ${user.organizationId}, ${successorTokenHash},
          ${isoFromSec(sec + REFRESH_TTL_SECONDS)}, ${null}, ${null}, ${isoFromSec(sec)}
        WHERE EXISTS (
          SELECT 1 FROM ${refreshTokens}
          WHERE ${refreshTokens.id} = ${row.id}
            AND ${refreshTokens.rotatedTo} = ${newId}
            AND ${refreshTokens.revokedAt} IS NULL
        )
      `,
    ),
    // 掃除: 期限切れ行はもう再利用検知に寄与しない(期限チェックが先に 401 を
    // 返す)ので、ローテーションのついでに削除する。放置するとテーブルが refresh
    // のたび無限に育ち、認証ホットパスの rows_read(無料枠 5M/日)を食い潰す。
    deps.db
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.userId, user.id), lte(refreshTokens.expiresAt, isoFromSec(sec)))),
  ])
  const inserted = results[1]?.meta.changes === 1
  if (!inserted) {
    return { ok: false, status: 401, error: 'rotation_race', keepCookie: true }
  }
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
  if (inv.consumedAt || new Date(inv.expiresAt).getTime() / 1000 <= sec) {
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
  // Invitation acceptance is account creation, not password reset. Keep this
  // invariant in the service layer as well as the HTTP route so another caller
  // cannot use a still-pending row to replace an existing credential.
  if (user.passwordHash) return { ok: false, status: 410, error: 'invite_expired' }
  // クロステナント防御: 招待の org とユーザーの所属 org が一致しない招待は
  // 受諾させない(他 org 既存ユーザーのパスワード上書き = アカウント乗っ取り防止)。
  if (user.organizationId !== inv.organizationId) {
    return { ok: false, status: 410, error: 'invite_expired' }
  }
  const org = await loadOrg(deps, user.organizationId)
  if (!org) return { ok: false, status: 404, error: 'org_not_found' }
  if (org.isDisabled === '1') return { ok: false, status: 403, error: 'org_disabled' }

  const passwordHash = await hashStretched(input.stretched, deps.pepper)
  const consumedAt = isoFromSec(sec)
  const claimNonce = crypto.randomUUID()
  // Claim the invitation first with a conditional update. Only the winner of
  // this statement can satisfy the EXISTS predicate in the following update;
  // a concurrent accept therefore cannot overwrite the winner's password.
  const [claim, passwordUpdate] = await deps.db.batch([
    deps.db
      .update(invitations)
      .set({ consumedAt, consumedNonce: claimNonce })
      .where(
        and(
          eq(invitations.id, inv.id),
          isNull(invitations.consumedAt),
          sql`${invitations.expiresAt} > ${consumedAt}`,
        ),
      ),
    deps.db
      .update(users)
      .set({ passwordHash })
      .where(
        and(
          eq(users.id, user.id),
          sql`EXISTS (
            SELECT 1 FROM invitations
            WHERE invitations.id = ${inv.id}
              AND invitations.consumed_at = ${consumedAt}
              AND invitations.consumed_nonce = ${claimNonce}
          )`,
        ),
      ),
    deps.db
      .update(invitations)
      .set({ consumedNonce: null })
      .where(and(eq(invitations.id, inv.id), eq(invitations.consumedNonce, claimNonce))),
  ])
  if (claim.meta.changes !== 1 || passwordUpdate.meta.changes !== 1) {
    return { ok: false, status: 410, error: 'invite_expired' }
  }
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
