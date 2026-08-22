import { z } from 'zod'

/**
 * 認証・テナンシーの Zod 単一ソース。
 * 認証は admin サービスが源泉、他サービスは /api/auth/* をプロキシする。
 */

export const Plan = z.enum(['free', 'contracted'])
export type Plan = z.infer<typeof Plan>

export const Role = z.enum(['admin', 'staff'])
export type Role = z.infer<typeof Role>

/**
 * JWT クレーム(access token)。旧テンプレの `{ org, exp }` と同名・同義の org を
 * 持つため**読み取り側**のテナントスコープコード(jwtPayload.org)は無変更で通るが、
 * sub/email/role が必須になったので**旧形式のトークン自体は検証で弾かれる**
 * (アップグレード時は既存トークンが失効 = 全員再ログイン。fail-closed で安全側)。
 * **plan はクレームに入れない**(org 同期行を毎リクエスト参照 = 即時反映)。
 */
export const AuthTokenPayload = z.looseObject({
  sub: z.string(), // users.id
  org: z.string(), // organizations.id(旧テンプレ既存クレームと同名・同義)
  email: z.string().email(),
  role: Role,
  exp: z.number(),
})
export type AuthTokenPayload = z.infer<typeof AuthTokenPayload>

/**
 * ログイン要求。パスワードは**クライアント側でストレッチング済みの値**を送る
 * (PBKDF2 600k、salt=email 導出。平文はネットワークに出さない。
 * Workers Free の CPU 10ms 制約への対応 — `@app/shared` の password.ts 参照)。
 */
export const LoginRequest = z.strictObject({
  email: z.string().email(),
  stretched: z.string().min(1), // クライアント側 PBKDF2 の出力(base64)
})
export type LoginRequest = z.infer<typeof LoginRequest>

export const AuthUser = z.strictObject({
  id: z.string(),
  email: z.string().email(),
  role: Role,
})
export type AuthUser = z.infer<typeof AuthUser>

export const AuthOrganization = z.strictObject({
  id: z.string(),
  name: z.string(),
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

// 招待発行(管理者操作)。org は URL(/api/organizations/:id/invitations)で指定
// するため body には含めない。admin worker の zValidator がこれを直接使う。
export const InviteRequest = z.strictObject({
  email: z.string().email(),
  role: Role.default('staff'),
})
export type InviteRequest = z.infer<typeof InviteRequest>

// 招待受諾(パスワード設定)。password はクライアントで 12 字以上を検証した上で
// ストレッチング済みの値を送る(平文長は UI 側で担保)。
// email はストレッチングの salt(入力ミスがあると別 salt でハッシュが保存され、
// 正しい email での以後のログインが永久に失敗する)。サーバが招待の email と
// 突合できるよう必ず送る。
export const AcceptInviteRequest = z.strictObject({
  token: z.string().min(32),
  email: z.string().email(),
  stretched: z.string().min(1),
})
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>

/**
 * dev トークングラント(`AUTH_DEV_GRANT === 'true'` のときのみ有効)。
 * 本番では fail close(未設定なら 404)。
 */
export const IssueTokenRequest = z.strictObject({
  organizationId: z.string().min(1),
  role: Role.default('staff'),
  email: z.string().email().default('dev@example.com'),
})
export type IssueTokenRequest = z.infer<typeof IssueTokenRequest>
