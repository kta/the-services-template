import { DOMAIN_ACCESS_TOKEN_AUDIENCE } from '@app/contracts'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_TTL_SECONDS,
  generateRefreshToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from '../src/jwt'
import { JWT_TEST_PRIVATE_KEY, JWT_TEST_PUBLIC_KEY } from './jwt-keys'

const claims = { sub: 'u1', org: 'o1', email: 'a@b.com', role: 'staff' as const }
const NOW = 1_800_000_000

describe('access token', () => {
  it('round-trips valid claims', async () => {
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, undefined, NOW)
    const payload = await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY, NOW)
    expect(payload).toMatchObject(claims)
    expect(payload?.exp).toBeGreaterThan(0)
  })

  it('sets exp to now + ttl', async () => {
    const now = NOW
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, ACCESS_TTL_SECONDS, now)
    const payload = await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY, now)
    expect(payload?.exp).toBe(now + ACCESS_TTL_SECONDS)
  })

  it('rejects a wrong secret', async () => {
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, undefined, NOW)
    expect(await verifyAccessToken(token, 'other-public-key', NOW)).toBeNull()
  })

  it('does not accept a domain token at the admin audience boundary', async () => {
    const token = await signAccessToken(
      claims,
      JWT_TEST_PRIVATE_KEY,
      undefined,
      NOW,
      DOMAIN_ACCESS_TOKEN_AUDIENCE,
    )
    expect(await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
    expect(
      await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY, NOW, DOMAIN_ACCESS_TOKEN_AUDIENCE),
    ).toMatchObject(claims)
  })

  it('rejects an expired token', async () => {
    const past = 1000
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY, ACCESS_TTL_SECONDS, past)
    expect(await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
  })

  it('rejects garbage', async () => {
    expect(await verifyAccessToken('not.a.jwt', JWT_TEST_PUBLIC_KEY, NOW)).toBeNull()
  })
})

describe('refresh token', () => {
  it('generates distinct high-entropy tokens', () => {
    const a = generateRefreshToken()
    const b = generateRefreshToken()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(43) // 32 bytes base64url
  })

  it('hashes deterministically to 64 hex chars', async () => {
    const t = generateRefreshToken()
    const h1 = await hashToken(t)
    const h2 = await hashToken(t)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different tokens hash differently', async () => {
    expect(await hashToken('a')).not.toBe(await hashToken('b'))
  })
})
