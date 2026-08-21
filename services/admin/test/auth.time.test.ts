/**
 * 認証コアの**時刻依存**ふるまいを、実時刻に頼らず固定時刻(`AuthConfig.now`)で
 * 検証する。実 D1 + 実 KV(workerd)。
 *
 * ここで守りたい不変条件:
 *  - access/refresh の寿命が定数どおり(勝手に伸びない・縮まない)
 *  - refresh は期限ちょうどまで有効、1 秒でも過ぎたら 401
 *  - ローテーション猶予は「ちょうど 30 秒」まで多タブ競合、超えたら盗難扱いで全 revoke
 *  - 明示ログアウト(revoke)済みトークンには猶予が無い
 *  - 招待は 72h ちょうどまで有効
 *  - ロックアウトは email+IP 単位で、成功すると解除される
 *
 * integration テスト(admin.integration.test.ts)は HTTP 経路の代表ケースを見る。
 * こちらは境界値の網羅担当。
 */

import { env } from 'cloudflare:test'
import { ACCESS_TTL_SECONDS, hashStretched, hashToken, REFRESH_TTL_SECONDS } from '@app/shared'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type AuthDeps,
  acceptInvite,
  LOCKOUT_WINDOW_SECONDS,
  login,
  MAX_LOGIN_FAILURES,
  ROTATION_GRACE_SECONDS,
  refresh,
  revokeOne,
} from '../src/worker/auth/service'
import { invitations, organizations, refreshTokens, users } from '../src/worker/db/schema'

const PEPPER = 'dev-auth-pepper-change-me'
const JWT_SECRET = 'dev-jwt-secret-change-me'
/** 基準時刻(固定)。2026-07-10T00:00:00Z。 */
const T0 = 1_783_641_600
const INVITE_TTL_SECONDS = 72 * 60 * 60

const iso = (sec: number) => new Date(sec * 1000).toISOString()
const db = () => drizzle(env.DB)

/** 固定時刻 `now` の deps を作る。 */
function depsAt(now: number): AuthDeps {
  return { db: db(), kv: env.AUTH_RL as never, pepper: PEPPER, jwtSecret: JWT_SECRET, now }
}

/** JWT の payload を署名検証せずに読む(期限切れトークンも観測したいため)。 */
function payloadOf(token: string): { exp: number; role: string; org: string } {
  const body = token.split('.')[1] ?? ''
  return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
}

const STRETCHED = 'stretched-correct-value'

/** org + パスワード設定済みユーザーを 1 件作る。 */
async function seedUser(opts: { email: string; orgDisabled?: boolean } = { email: 'u@org.test' }) {
  const orgId = `org-${crypto.randomUUID()}`
  const userId = `user-${crypto.randomUUID()}`
  await db()
    .insert(organizations)
    .values({
      id: orgId,
      name: 'Org',
      plan: 'free',
      isDisabled: opts.orgDisabled ? '1' : '0',
      isOperator: '0',
      createdAt: iso(T0),
    })
  await db()
    .insert(users)
    .values({
      id: userId,
      organizationId: orgId,
      email: opts.email,
      passwordHash: await hashStretched(STRETCHED, PEPPER),
      role: 'staff',
      createdAt: iso(T0),
    })
  return { orgId, userId }
}

beforeEach(async () => {
  // D1 はテスト間で共有される(巻き戻らない)。refresh 行だけは「そのユーザーの
  // 全 revoke」等の観測に効くので毎回まっさらにする。org/user は毎回ユニーク id。
  await db().delete(refreshTokens)
})

describe('セッション発行の寿命(定数どおりか)', () => {
  it('access の exp は now + ACCESS_TTL、refresh 行の期限は now + REFRESH_TTL', async () => {
    await seedUser({ email: 'ttl@org.test' })
    const out = await login(depsAt(T0), { email: 'ttl@org.test', stretched: STRETCHED })
    expect(out.ok).toBe(true)
    if (!out.ok) return

    expect(payloadOf(out.response.token).exp).toBe(T0 + ACCESS_TTL_SECONDS)
    const rows = await db()
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await hashToken(out.response.refreshToken)))
    expect(rows[0]?.expiresAt).toBe(iso(T0 + REFRESH_TTL_SECONDS))
    expect(rows[0]?.createdAt).toBe(iso(T0))
  })

  it('発行される access トークンは呼び出し時刻に追従する(now を変えれば exp も動く)', async () => {
    await seedUser({ email: 'ttl2@org.test' })
    const later = T0 + 86_400
    const out = await login(depsAt(later), { email: 'ttl2@org.test', stretched: STRETCHED })
    if (!out.ok) throw new Error('login failed')
    expect(payloadOf(out.response.token).exp).toBe(later + ACCESS_TTL_SECONDS)
  })
})

describe('refresh の有効期限の境界', () => {
  it('期限ちょうど(expiresAt == now)はまだ有効', async () => {
    await seedUser({ email: 'exp-edge@org.test' })
    const first = await login(depsAt(T0), { email: 'exp-edge@org.test', stretched: STRETCHED })
    if (!first.ok) throw new Error('login failed')

    const out = await refresh(depsAt(T0 + REFRESH_TTL_SECONDS), {
      refreshToken: first.response.refreshToken,
    })
    expect(out.ok).toBe(true)
  })

  it('期限を 1 秒でも過ぎたら expired_token(401)', async () => {
    await seedUser({ email: 'expired@org.test' })
    const first = await login(depsAt(T0), { email: 'expired@org.test', stretched: STRETCHED })
    if (!first.ok) throw new Error('login failed')

    const out = await refresh(depsAt(T0 + REFRESH_TTL_SECONDS + 1), {
      refreshToken: first.response.refreshToken,
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(401)
      expect(out.error).toBe('expired_token')
    }
  })

  it('期限切れは「盗難」ではない — 他セッションを巻き添えで revoke しない', async () => {
    const { userId } = await seedUser({ email: 'expired2@org.test' })
    const a = await login(depsAt(T0), { email: 'expired2@org.test', stretched: STRETCHED })
    const b = await login(depsAt(T0), { email: 'expired2@org.test', stretched: STRETCHED })
    if (!a.ok || !b.ok) throw new Error('login failed')

    await refresh(depsAt(T0 + REFRESH_TTL_SECONDS + 1), { refreshToken: a.response.refreshToken })

    const alive = await db().select().from(refreshTokens).where(eq(refreshTokens.userId, userId))
    expect(alive.every((r) => r.revokedAt === null)).toBe(true)
  })
})

describe('ローテーション猶予(多タブ競合 vs 盗難)の境界', () => {
  /** login → refresh(T0+10 でローテーション)。旧トークンと後継を返す。 */
  async function rotated(email: string) {
    await seedUser({ email })
    const first = await login(depsAt(T0), { email, stretched: STRETCHED })
    if (!first.ok) throw new Error('login failed')
    const rotateAt = T0 + 10
    const second = await refresh(depsAt(rotateAt), {
      refreshToken: first.response.refreshToken,
    })
    if (!second.ok) throw new Error('rotate failed')
    return { old: first.response.refreshToken, next: second.response.refreshToken, rotateAt }
  }

  it('猶予ちょうど(+30 秒)の旧トークン再提示は rotation_race(cookie を保持)', async () => {
    const { old, rotateAt } = await rotated('grace-edge@org.test')
    const out = await refresh(depsAt(rotateAt + ROTATION_GRACE_SECONDS), { refreshToken: old })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toBe('rotation_race')
      expect(out.keepCookie).toBe(true)
      expect(out.status).toBe(401)
    }
  })

  it('猶予内の再提示では後継トークンが生き残る(強制ログアウトしない)', async () => {
    const { old, next, rotateAt } = await rotated('grace-alive@org.test')
    await refresh(depsAt(rotateAt + ROTATION_GRACE_SECONDS), { refreshToken: old })
    const after = await refresh(depsAt(rotateAt + ROTATION_GRACE_SECONDS + 1), {
      refreshToken: next,
    })
    expect(after.ok).toBe(true)
  })

  it('猶予を 1 秒超えた再提示は token_reuse + そのユーザーの全 refresh を revoke', async () => {
    const { old, next, rotateAt } = await rotated('theft@org.test')
    const out = await refresh(depsAt(rotateAt + ROTATION_GRACE_SECONDS + 1), { refreshToken: old })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toBe('token_reuse')
      expect(out.keepCookie).toBeUndefined() // cookie は消す
    }
    // 後継も道連れ(盗難時は全セッションを切る)
    const after = await refresh(depsAt(rotateAt + ROTATION_GRACE_SECONDS + 2), {
      refreshToken: next,
    })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error).toBe('token_reuse')
  })

  it('明示ログアウトで revoke 済みのトークンには猶予が無い(即 token_reuse)', async () => {
    await seedUser({ email: 'logout@org.test' })
    const first = await login(depsAt(T0), { email: 'logout@org.test', stretched: STRETCHED })
    if (!first.ok) throw new Error('login failed')
    await revokeOne(depsAt(T0 + 1), first.response.refreshToken)

    // ローテーション直後と同じ時間差でも、revoked は猶予対象外。
    const out = await refresh(depsAt(T0 + 2), { refreshToken: first.response.refreshToken })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toBe('token_reuse')
  })
})

describe('ローテーション時の期限切れ行の掃除(認証ホットパスの rows_read 対策)', () => {
  it('同一ユーザーの期限切れ refresh 行はローテーションのついでに削除される', async () => {
    const { userId, orgId } = await seedUser({ email: 'cleanup@org.test' })
    // 期限切れの残骸を仕込む
    await db()
      .insert(refreshTokens)
      .values({
        id: 'stale-row',
        userId,
        organizationId: orgId,
        tokenHash: await hashToken('stale-token'),
        expiresAt: iso(T0 - 1),
        rotatedTo: null,
        revokedAt: null,
        createdAt: iso(T0 - REFRESH_TTL_SECONDS),
      })

    const first = await login(depsAt(T0), { email: 'cleanup@org.test', stretched: STRETCHED })
    if (!first.ok) throw new Error('login failed')
    const out = await refresh(depsAt(T0 + 60), { refreshToken: first.response.refreshToken })
    expect(out.ok).toBe(true)

    const stale = await db()
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.id, 'stale-row')))
    expect(stale).toHaveLength(0)
  })
})

describe('招待の有効期限(72h)の境界', () => {
  async function seedInvite(email: string, expiresAtSec: number) {
    const orgId = `org-${crypto.randomUUID()}`
    const token = `invite-token-${crypto.randomUUID()}`
    await db()
      .insert(organizations)
      .values({
        id: orgId,
        name: 'InviteOrg',
        plan: 'free',
        isDisabled: '0',
        isOperator: '0',
        createdAt: iso(T0),
      })
    await db()
      .insert(users)
      .values({
        id: `user-${crypto.randomUUID()}`,
        organizationId: orgId,
        email,
        passwordHash: null,
        role: 'staff',
        createdAt: iso(T0),
      })
    await db()
      .insert(invitations)
      .values({
        id: `inv-${crypto.randomUUID()}`,
        organizationId: orgId,
        email,
        tokenHash: await hashToken(token),
        expiresAt: iso(expiresAtSec),
        consumedAt: null,
        createdAt: iso(T0),
      })
    return { token, orgId }
  }

  it('期限ちょうど(72h 後)はまだ受諾できる', async () => {
    const expiresAt = T0 + INVITE_TTL_SECONDS
    const { token } = await seedInvite('inv-edge@org.test', expiresAt)
    const out = await acceptInvite(depsAt(expiresAt), {
      token,
      email: 'inv-edge@org.test',
      stretched: STRETCHED,
    })
    expect(out.ok).toBe(true)
  })

  it('1 秒過ぎたら 410 invite_expired', async () => {
    const expiresAt = T0 + INVITE_TTL_SECONDS
    const { token } = await seedInvite('inv-late@org.test', expiresAt)
    const out = await acceptInvite(depsAt(expiresAt + 1), {
      token,
      email: 'inv-late@org.test',
      stretched: STRETCHED,
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(410)
      expect(out.error).toBe('invite_expired')
    }
  })

  it('受諾すると consumedAt が受諾時刻で記録され、二度目は 410', async () => {
    const { token } = await seedInvite('inv-once@org.test', T0 + INVITE_TTL_SECONDS)
    const acceptedAt = T0 + 3600
    expect(
      (
        await acceptInvite(depsAt(acceptedAt), {
          token,
          email: 'inv-once@org.test',
          stretched: STRETCHED,
        })
      ).ok,
    ).toBe(true)

    const rows = await db()
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, await hashToken(token)))
    expect(rows[0]?.consumedAt).toBe(iso(acceptedAt))

    const second = await acceptInvite(depsAt(acceptedAt + 1), {
      token,
      email: 'inv-once@org.test',
      stretched: STRETCHED,
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toBe('invite_expired')
  })

  it('期限内でも email が招待と違えば 400 email_mismatch(アカウント破壊の防止)', async () => {
    const { token } = await seedInvite('inv-typo@org.test', T0 + INVITE_TTL_SECONDS)
    const out = await acceptInvite(depsAt(T0 + 60), {
      token,
      email: 'inv-typo+typo@org.test',
      stretched: STRETCHED,
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(400)
      expect(out.error).toBe('email_mismatch')
    }
  })
})

describe('ログインのロックアウト(email+IP 単位)', () => {
  it(`${MAX_LOGIN_FAILURES} 回失敗で 429、Retry-After はロックアウト窓と一致`, async () => {
    await seedUser({ email: 'lock-unit@org.test' })
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      const bad = await login(depsAt(T0 + i), {
        email: 'lock-unit@org.test',
        stretched: 'WRONG',
        ip: '203.0.113.1',
      })
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.status).toBe(401)
    }
    const locked = await login(depsAt(T0 + 10), {
      email: 'lock-unit@org.test',
      stretched: STRETCHED, // 正しい資格情報でも通さない
      ip: '203.0.113.1',
    })
    expect(locked.ok).toBe(false)
    if (!locked.ok) {
      expect(locked.status).toBe(429)
      expect(locked.retryAfter).toBe(LOCKOUT_WINDOW_SECONDS)
    }
  })

  it('カウンタは email+IP 単位 — 別 IP からのログインは巻き添えにしない', async () => {
    await seedUser({ email: 'lock-ip@org.test' })
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await login(depsAt(T0 + i), {
        email: 'lock-ip@org.test',
        stretched: 'WRONG',
        ip: '203.0.113.1',
      })
    }
    const otherIp = await login(depsAt(T0 + 10), {
      email: 'lock-ip@org.test',
      stretched: STRETCHED,
      ip: '198.51.100.9',
    })
    expect(otherIp.ok).toBe(true)
  })

  it('しきい値未満で成功するとカウンタが解除される(次の失敗が 1 回目に戻る)', async () => {
    await seedUser({ email: 'lock-reset@org.test' })
    for (let i = 0; i < MAX_LOGIN_FAILURES - 1; i++) {
      await login(depsAt(T0 + i), {
        email: 'lock-reset@org.test',
        stretched: 'WRONG',
        ip: '203.0.113.2',
      })
    }
    const ok = await login(depsAt(T0 + 5), {
      email: 'lock-reset@org.test',
      stretched: STRETCHED,
      ip: '203.0.113.2',
    })
    expect(ok.ok).toBe(true)

    // 解除後に再び 4 回失敗しても、まだロックされない(カウントが 0 から数え直し)
    for (let i = 0; i < MAX_LOGIN_FAILURES - 1; i++) {
      const bad = await login(depsAt(T0 + 6 + i), {
        email: 'lock-reset@org.test',
        stretched: 'WRONG',
        ip: '203.0.113.2',
      })
      if (!bad.ok) expect(bad.status).toBe(401)
    }
    const stillAllowed = await login(depsAt(T0 + 20), {
      email: 'lock-reset@org.test',
      stretched: STRETCHED,
      ip: '203.0.113.2',
    })
    expect(stillAllowed.ok).toBe(true)
  })

  it('ip 未指定は "unknown" キーにまとまる(集計されるが他 IP を巻き込まない)', async () => {
    await seedUser({ email: 'lock-unknown@org.test' })
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await login(depsAt(T0 + i), { email: 'lock-unknown@org.test', stretched: 'WRONG' })
    }
    const locked = await login(depsAt(T0 + 10), {
      email: 'lock-unknown@org.test',
      stretched: STRETCHED,
    })
    expect(locked.ok).toBe(false)
    const withIp = await login(depsAt(T0 + 10), {
      email: 'lock-unknown@org.test',
      stretched: STRETCHED,
      ip: '203.0.113.7',
    })
    expect(withIp.ok).toBe(true)
  })
})
