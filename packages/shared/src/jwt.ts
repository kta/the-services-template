/**
 * トークン発行・検証。
 *
 * - access: hono/jwt の HS256。クレームは契約 `AuthTokenPayload`
 *   `{ sub, org, email, role, exp }`。**plan は入れない**(org 同期行を毎req参照)。
 * - refresh: 高エントロピーの不透明トークン(JWT ではない)。DB には SHA-256
 *   ハッシュのみ保存し、平文はローテーション時に一度だけ渡す。
 *
 * **audience 未設定に注意**: JWT_SECRET は admin(発行)と各ドメインサービス
 * (検証)で共有され、`aud`/`iss` クレームが無いため、1 つの access token は
 * secret を共有する**全サービス**で有効になる。テナントトークンを信用しては
 * いけないサービス(課金・運用系 API 等)を将来足す場合は、secret を分けるか
 * `aud` クレームの導入(= 全トークン再発行)を先に行うこと。
 *
 * WebCrypto のみ(Workers ネイティブ / node 22 でも動く)。
 */
import { AuthTokenPayload, type Role } from '@app/contracts'
import { sign, verify } from 'hono/jwt'

export const ACCESS_TTL_SECONDS = 15 * 60 // 15 分
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 日

export type AccessClaims = {
  sub: string
  org: string
  email: string
  role: Role
}

/** access JWT を発行(exp = now + ttl)。 */
export async function signAccessToken(
  claims: AccessClaims,
  secret: string,
  ttlSeconds = ACCESS_TTL_SECONDS,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  return sign({ ...claims, exp: now + ttlSeconds }, secret, 'HS256')
}

/**
 * access JWT を検証し、契約でパースして返す。失敗(署名不正・期限切れ・形不正)
 * は null。呼び出し側は null を 401 に写像する。
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AuthTokenPayload | null> {
  try {
    const raw = await verify(token, secret, 'HS256')
    const parsed = AuthTokenPayload.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
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
