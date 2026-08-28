/**
 * トークン発行・検証。
 *
 * - access: hono/jwt の RS256。クレームは契約 `AuthTokenPayload`
 *   `{ sub, org, email, role, sid, exp, iss, aud }`。**plan は入れない**
 *   (org 同期行を毎req参照)。issuer は admin 固定、audience は検証対象 Worker ごとに
 *   固定して token の再利用境界を守る。
 * - refresh: 高エントロピーの不透明トークン(JWT ではない)。DB には SHA-256
 *   ハッシュのみ保存し、平文はローテーション時に一度だけ渡す。
 *
 * 署名用 private key は認証源泉の admin だけが持ち、各ドメインサービスには
 * 検証用 public key だけを設定する。これにより domain Worker の侵害だけでは
 * admin 用 token を新規発行できない。algorithm は header 任せにせず、ここで
 * RS256 に固定する。
 *
 * WebCrypto のみ(Workers ネイティブ / node 22 でも動く)。
 */
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  type AccessTokenAudience,
  AuthTokenPayload,
  type Role,
} from '@app/contracts'
import { sign, verify } from 'hono/jwt'

export const ACCESS_TTL_SECONDS = 15 * 60 // 15 分
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 日
export const ACCESS_TOKEN_ALGORITHM = 'RS256' as const

/** Hono が WebCrypto に渡せる JWT private/public key。通常は PEM 文字列を使う。 */
export type AccessTokenKey = Parameters<typeof sign>[1]

export type AccessClaims = {
  sub: string
  org: string
  email: string
  role: Role
  /** admin が access JWT を live refresh session に束縛する値。 */
  sid?: string
}

/** access JWT を発行(exp = now + ttl)。 */
export async function signAccessToken(
  claims: AccessClaims,
  privateKey: AccessTokenKey,
  ttlSeconds = ACCESS_TTL_SECONDS,
  now = Math.floor(Date.now() / 1000),
  audience: AccessTokenAudience = ACCESS_TOKEN_AUDIENCE,
): Promise<string> {
  return sign(
    {
      ...claims,
      aud: audience,
      exp: now + ttlSeconds,
      iss: ACCESS_TOKEN_ISSUER,
    },
    privateKey,
    ACCESS_TOKEN_ALGORITHM,
  )
}

/**
 * access JWT を検証し、契約でパースして返す。失敗(署名不正・期限切れ・形不正)
 * は null。呼び出し側は null を 401 に写像する。
 */
export async function verifyAccessToken(
  token: string,
  publicKey: AccessTokenKey,
  now = Math.floor(Date.now() / 1000),
  audience: AccessTokenAudience = ACCESS_TOKEN_AUDIENCE,
): Promise<AuthTokenPayload | null> {
  try {
    const raw = await verify(token, publicKey, {
      alg: ACCESS_TOKEN_ALGORITHM,
      aud: audience,
      iss: ACCESS_TOKEN_ISSUER,
      // Hono's built-in temporal checks use Date.now() directly. Disable
      // those checks and apply the same NumericDate rules against the
      // injected clock below, so callers and boundary tests share one clock.
      exp: false,
      iat: false,
      nbf: false,
    })
    if (!validTemporalClaims(raw, now)) return null
    const parsed = AuthTokenPayload.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function validTemporalClaims(raw: unknown, now: number): boolean {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(now)) return false
  const claims = raw as { exp?: unknown; iat?: unknown; nbf?: unknown }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now) {
    return false
  }
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > now) {
      return false
    }
  }
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now) {
      return false
    }
  }
  return true
}

const enc = new TextEncoder()

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 256bit のランダムな不透明 refresh トークン(base64url)を生成。 */
export function generateRefreshToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

/**
 * refresh トークンの保存用ハッシュ(SHA-256 hex)。高エントロピー乱数なので
 * pepper/ストレッチは不要(パスワードとは前提が違う)。定数時間比較は
 * ハッシュ一致検索(WHERE token_hash = ?)で担保。
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
