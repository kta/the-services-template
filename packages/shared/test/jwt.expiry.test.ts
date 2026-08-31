/**
 * access JWT の**期限と改ざん耐性**の境界テスト。
 *
 * jwt.test.ts が往復と代表的な失敗を押さえるのに対し、ここは
 * 「期限ちょうど / 1 秒前後」「アルゴリズム混同」「クレーム改ざん」「TTL 定数の
 * 回帰」といった、認証の穴になる境目を固定する。
 */

import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from '@app/contracts'
import { sign as signJwt } from 'hono/jwt'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_TTL_SECONDS,
  hashToken,
  REFRESH_TTL_SECONDS,
  signAccessToken,
  verifyAccessToken,
} from '../src/jwt'
import { JWT_TEST_PRIVATE_KEY, JWT_TEST_PUBLIC_KEY } from './jwt-keys'

const claims = { sub: 'u1', org: 'o1', email: 'a@b.com', role: 'staff' as const }
const NOW = 1_800_000_000

/** now(秒)を起点に「あと ttl 秒有効」なトークンを作る。 */
function tokenValidFor(ttl: number) {
  return signAccessToken(claims, JWT_TEST_PRIVATE_KEY, ttl, NOW)
}

describe('TTL 定数(変更は全セッションの寿命に効くので回帰させる)', () => {
  it('access は 15 分、refresh は 30 日', () => {
    expect(ACCESS_TTL_SECONDS).toBe(15 * 60)
    expect(REFRESH_TTL_SECONDS).toBe(30 * 24 * 60 * 60)
  })
})

describe('期限の境界', () => {
  it('残り 1 秒のトークンは有効', async () => {
    expect(await verifyAccessToken(await tokenValidFor(1), JWT_TEST_PUBLIC_KEY, NOW)).toMatchObject(
      claims,
    )
  })

  it('1 秒前に失効したトークンは無効(null)', async () => {
    expect(await verifyAccessToken(await tokenValidFor(-1), JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
  })

  it('exp が現在時刻ちょうどのトークンは受け付けない(期限切れ側に倒す)', async () => {
    const now = NOW
    // ttl=0 → exp == now。境界は「まだ有効」ではなく「失効」に倒れることを固定する。
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, 0, now)
    expect(await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY, now)).toBeNull()
  })

  it('exp は now + ttl(任意 TTL でも計算がずれない)', async () => {
    const now = 1_800_000_000
    for (const ttl of [1, 60, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS]) {
      const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, ttl, now)
      // 期限切れでも payload を見たいので、署名検証を通さず payload を直接読む。
      const [, body] = token.split('.')
      const decoded = JSON.parse(atob((body ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as {
        exp: number
      }
      expect(decoded.exp).toBe(now + ttl)
    }
  })

  it('検証時刻を注入でき、iat / nbf の未来値も拒否する', async () => {
    const token = await signJwt(
      {
        ...claims,
        exp: NOW + 60,
        iat: NOW + 1,
        nbf: NOW + 1,
      },
      JWT_TEST_PRIVATE_KEY,
      'RS256',
    )
    expect(await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
    expect(await verifyAccessToken(await tokenValidFor(1), JWT_TEST_PUBLIC_KEY, NOW + 1)).toBeNull()
  })

  it('iat / nbf は現在時刻ちょうどなら許可し、非有限値は拒否する', async () => {
    const valid = await signJwt(
      {
        ...claims,
        aud: ACCESS_TOKEN_AUDIENCE,
        exp: NOW + 60,
        iat: NOW,
        iss: ACCESS_TOKEN_ISSUER,
        nbf: NOW,
      },
      JWT_TEST_PRIVATE_KEY,
      'RS256',
    )
    expect(await verifyAccessToken(valid, JWT_TEST_PUBLIC_KEY, NOW)).toMatchObject(claims)

    const invalidIat = await signJwt(
      {
        ...claims,
        aud: ACCESS_TOKEN_AUDIENCE,
        exp: NOW + 60,
        iat: Number.NaN,
        iss: ACCESS_TOKEN_ISSUER,
      },
      JWT_TEST_PRIVATE_KEY,
      'RS256',
    )
    expect(await verifyAccessToken(invalidIat, JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()

    const invalidNbf = await signJwt(
      {
        ...claims,
        aud: ACCESS_TOKEN_AUDIENCE,
        exp: NOW + 60,
        iss: ACCESS_TOKEN_ISSUER,
        nbf: Number.POSITIVE_INFINITY,
      },
      JWT_TEST_PRIVATE_KEY,
      'RS256',
    )
    expect(await verifyAccessToken(invalidNbf, JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
  })

  it('遠い未来のトークンも(署名が正しければ)有効 — 期限だけが唯一の時間ゲート', async () => {
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, 10 * 365 * 24 * 60 * 60, NOW)
    expect(await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY, NOW)).toMatchObject(claims)
  })
})

describe('改ざん・アルゴリズム混同', () => {
  it('payload を書き換えたトークンは無効(署名が合わない)', async () => {
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, undefined, NOW)
    const [head, body, sig] = token.split('.')
    const tampered = JSON.parse(atob((body ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >
    tampered.role = 'admin' // 権限昇格の試み
    const forgedBody = btoa(JSON.stringify(tampered))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(
      await verifyAccessToken(`${head}.${forgedBody}.${sig}`, JWT_TEST_PUBLIC_KEY, NOW),
    ).toBeNull()
  })

  it('alg=none の無署名トークンは無効(alg 混同攻撃)', async () => {
    const b64 = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      ...claims,
      exp: NOW + 600,
    })}.`
    expect(await verifyAccessToken(none, JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
  })

  it('署名だけ差し替えたトークンは無効', async () => {
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, undefined, NOW)
    const [head, body] = token.split('.')
    expect(await verifyAccessToken(`${head}.${body}.AAAA`, JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
  })

  it('空文字・区切り不足は例外にせず null', async () => {
    expect(await verifyAccessToken('', JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
    expect(await verifyAccessToken('only-one-part', JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
  })
})

describe('クレーム契約(role は列挙のみ)', () => {
  it('契約外の role を持つ正しい署名のトークンも拒否する', async () => {
    // 署名は正しいが role が契約外 = 上流の実装ミス。素通しすると未知ロールが
    // requireRole を素通りし得るので、契約パースで落とす。
    const forged = await signAccessToken(
      { ...claims, role: 'superuser' as unknown as typeof claims.role },
      JWT_TEST_PRIVATE_KEY,
      undefined,
      NOW,
    )
    expect(await verifyAccessToken(forged, JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
  })
})

describe('refresh トークンのハッシュ(保存形式)', () => {
  it('大文字小文字・前後空白を区別する(正規化しない)', async () => {
    expect(await hashToken('abc')).not.toBe(await hashToken('ABC'))
    expect(await hashToken('abc')).not.toBe(await hashToken(' abc'))
  })
})
