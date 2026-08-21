import { describe, expect, it } from 'vitest'
import {
  ACCESS_TTL_SECONDS,
  generateRefreshToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from '../src/jwt'

const SECRET = 'test-secret-please-change'
const claims = { sub: 'u1', org: 'o1', email: 'a@b.com', role: 'staff' as const }

describe('access token', () => {
  it('round-trips valid claims', async () => {
    const token = await signAccessToken(claims, SECRET)
    const payload = await verifyAccessToken(token, SECRET)
    expect(payload).toMatchObject(claims)
    expect(payload?.exp).toBeGreaterThan(0)
  })

  it('sets exp to now + ttl', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await signAccessToken(claims, SECRET, ACCESS_TTL_SECONDS, now)
    const payload = await verifyAccessToken(token, SECRET)
    expect(payload?.exp).toBe(now + ACCESS_TTL_SECONDS)
  })

  it('rejects a wrong secret', async () => {
    const token = await signAccessToken(claims, SECRET)
    expect(await verifyAccessToken(token, 'other-secret')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const past = 1000
    const token = await signAccessToken(claims, SECRET, ACCESS_TTL_SECONDS, past)
    expect(await verifyAccessToken(token, SECRET)).toBeNull()
  })

  it('rejects garbage', async () => {
    expect(await verifyAccessToken('not.a.jwt', SECRET)).toBeNull()
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
