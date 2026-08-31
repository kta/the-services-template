/**
 * access JWT の鍵境界テスト。
 * admin だけが private key を持ち、domain は public key で検証する契約を固定する。
 */
import { sign as signJwt } from 'hono/jwt'
import { describe, expect, it } from 'vitest'
import { signAccessToken, verifyAccessToken } from '../src/jwt'
import { JWT_TEST_PRIVATE_KEY, JWT_TEST_PUBLIC_KEY } from './jwt-keys'

const claims = { sub: 'u1', org: 'o1', email: 'a@b.com', role: 'staff' as const }
const futureExpiry = 2_000_000_000

describe('access JWT の署名鍵境界', () => {
  it('private key で署名し、対応する public key で検証できる', async () => {
    const token = await signAccessToken(claims, JWT_TEST_PRIVATE_KEY)

    expect(await verifyAccessToken(token, JWT_TEST_PUBLIC_KEY)).toMatchObject(claims)
    expect(token.split('.')[0]).toBe('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9')
  })

  it('旧 HS256 token は public-key verifier で受け付けない', async () => {
    const legacy = await signJwt({ ...claims, exp: futureExpiry }, 'legacy-shared-secret', 'HS256')

    expect(await verifyAccessToken(legacy, JWT_TEST_PUBLIC_KEY)).toBeNull()
  })

  it.each([
    [{}, 'missing issuer and audience'],
    [{ iss: 'other-issuer', aud: 'other-audience' }, 'wrong issuer'],
    [{ iss: 'admin', aud: 'other-audience' }, 'wrong audience'],
  ])('issuer/audience が不正な RS256 token (%s) は受け付けない', async (overrides) => {
    const legacy = await signJwt(
      { ...claims, exp: futureExpiry, ...overrides },
      JWT_TEST_PRIVATE_KEY,
      'RS256',
    )

    expect(await verifyAccessToken(legacy, JWT_TEST_PUBLIC_KEY)).toBeNull()
  })

  it('別の private key で署名した token は受け付けない', async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const forged = await signJwt({ ...claims, exp: futureExpiry }, pair.privateKey, 'RS256')

    expect(await verifyAccessToken(forged, JWT_TEST_PUBLIC_KEY)).toBeNull()
  })
})
