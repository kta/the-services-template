import { z } from 'zod'

/**
 * 認証・テナンシーの Zod 単一ソース。
 * 認証は admin サービスが源泉、他サービスは /api/auth/* をプロキシする。
 */

export const Plan = z.enum(['free', 'contracted'])
export type Plan = z.infer<typeof Plan>

export const Role = z.enum(['admin', 'staff'])
export type Role = z.infer<typeof Role>

// These values are part of the access-token contract, not deployment config.
// Every Worker verifies the audience for its own API, so a valid signature
// cannot be replayed across an application boundary. `ACCESS_TOKEN_AUDIENCE`
// remains the admin audience for compatibility with the shared helper name;
// copied domains must use `domain:<service-name>`.
export const ACCESS_TOKEN_ISSUER = 'admin' as const
export const ACCESS_TOKEN_AUDIENCE = 'admin' as const
export const DOMAIN_ACCESS_TOKEN_AUDIENCE = 'domain:example_service' as const
export const AccessTokenAudience = z
  .string()
  .regex(/^admin$|^domain:[a-z][a-z0-9_]{0,62}$/, 'invalid access-token audience')
export type AccessTokenAudience = z.infer<typeof AccessTokenAudience>

/** Build the audience for one concrete domain Worker. */
export function domainAccessTokenAudience(service: string): AccessTokenAudience {
  return AccessTokenAudience.parse(`domain:${service}`)
}

// Protocol limits are part of the contract, so oversized input is rejected
// before any password hashing or database work can start.
export const EmailAddress = z.string().email().max(320)
const EntityId = z.string().min(1).max(128)
export const StretchedPassword = z.string().min(1).max(512)
export const RefreshToken = z.string().min(32).max(512)

/**
 * JWT クレーム(access token)。旧テンプレの `{ org, exp }` と同名・同義の org を
 * 持つため**読み取り側**のテナントスコープコード(jwtPayload.org)は無変更で通るが、
 * sub/email/role が必須になったので**旧形式のトークン自体は検証で弾かれる**
 * (アップグレード時は既存トークンが失効 = 全員再ログイン。fail-closed で安全側)。
 * issuer は admin 発行に固定し、audience は admin または対象 domain ごとに固定する。
 * 各 Worker は自分の audience だけを検証し、別用途の署名済み token をこの API に
 * 持ち込ませない。**plan はクレームに入れない**(org 同期行を毎リクエスト
 * 参照 = 即時反映)。
 */
export const AuthTokenPayload = z.looseObject({
  sub: EntityId, // users.id
  org: EntityId, // organizations.id(旧テンプレ既存クレームと同名・同義)
  // admin の access token は refresh session の DB 行にも束縛する。ドメイン側
  // は admin の session DB を持たないため、この claim は読み取り互換の optional。
  sid: EntityId.optional(),
  email: EmailAddress,
  role: Role,
  exp: z.number(),
  iss: z.literal(ACCESS_TOKEN_ISSUER),
  aud: AccessTokenAudience,
})
export type AuthTokenPayload = z.infer<typeof AuthTokenPayload>

/**
 * ログイン要求。パスワードは**クライアント側でストレッチング済みの値**を送る
 * (PBKDF2 600k、salt=email 導出。平文はネットワークに出さない。
 * Workers Free の CPU 10ms 制約への対応 — `@app/shared` の password.ts 参照)。
 */
export const LoginRequest = z.strictObject({
  email: EmailAddress,
  stretched: StretchedPassword, // クライアント側 PBKDF2 の出力(base64)
})
export type LoginRequest = z.infer<typeof LoginRequest>

export const AuthUser = z.strictObject({
  id: EntityId,
  email: EmailAddress,
  role: Role,
})
export type AuthUser = z.infer<typeof AuthUser>

export const AuthOrganization = z.strictObject({
  id: EntityId,
  name: z.string().min(1).max(200),
  plan: Plan,
  isDisabled: z.boolean(),
})
export type AuthOrganization = z.infer<typeof AuthOrganization>

// access token はレスポンス body(メモリ保持)、refresh は HttpOnly cookie 側
export const LoginResponse = z.strictObject({
  token: z.string(),
  user: AuthUser,
  organization: AuthOrganization,
  // internal API は refresh の平文を返し、境界(プロキシする Worker)が HttpOnly
  // cookie に載せる。同一オリジン proxy 前提なのでここでは body で受け渡す。
  refreshToken: z.string(),
})
export type LoginResponse = z.infer<typeof LoginResponse>

// refresh ローテーションの応答(新 access + 新 refresh)。
export const RefreshResponse = z.strictObject({
  token: z.string(),
  refreshToken: z.string(),
})
export type RefreshResponse = z.infer<typeof RefreshResponse>

/**
 * Domain → admin live-session check. A domain never receives the admin D1 or
 * JWT private key; it asks the admin Worker over its dedicated service binding
 * whether the already verified access token still has an active refresh row.
 */
export const AuthSessionCheckRequest = z.strictObject({
  sid: EntityId,
  sub: EntityId,
  org: EntityId,
})
export type AuthSessionCheckRequest = z.infer<typeof AuthSessionCheckRequest>

export const AuthSessionStatus = z.strictObject({
  active: z.boolean(),
  role: Role.nullable(),
})
export type AuthSessionStatus = z.infer<typeof AuthSessionStatus>

// 招待発行(管理者操作)。org は URL(/api/organizations/:id/invitations)で指定
// するため body には含めない。admin worker の zValidator がこれを直接使う。
export const InviteRequest = z.strictObject({
  email: EmailAddress,
  role: Role.default('staff'),
})
export type InviteRequest = z.infer<typeof InviteRequest>

// 招待受諾(パスワード設定)。password はクライアントで 12 字以上を検証した上で
// ストレッチング済みの値を送る(平文長は UI 側で担保)。
// email はストレッチングの salt(入力ミスがあると別 salt でハッシュが保存され、
// 正しい email での以後のログインが永久に失敗する)。サーバが招待の email と
// 突合できるよう必ず送る。
export const AcceptInviteRequest = z.strictObject({
  token: RefreshToken,
  email: EmailAddress,
  stretched: StretchedPassword,
})
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>

/**
 * dev トークングラント(`AUTH_DEV_GRANT === 'true'` のときのみ有効)。
 * 本番では fail close(未設定なら 404)。
 */
export const IssueTokenRequest = z.strictObject({
  organizationId: EntityId,
  role: Role.default('staff'),
  email: EmailAddress.default('dev@example.com'),
})
export type IssueTokenRequest = z.infer<typeof IssueTokenRequest>
