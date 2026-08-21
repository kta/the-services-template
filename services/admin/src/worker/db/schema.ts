import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// admin D1 は認証・組織(テナント)・プランの源泉。
// 規約: FK は宣言しない / ID はアプリ生成(crypto.randomUUID)/ DDL DEFAULT 禁止
// (既定値はアプリ層で設定)。真偽・時刻は text で保持(is_disabled は '0'/'1'、
// 時刻は ISO8601 文字列)。cross-D1 JOIN は無いのでテーブルは全て admin ローカル。

/** 組織(テナント境界・プラン・無効化の単位)。他ドメイン D1 へ同期コピーされる。 */
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').notNull(), // 'free' | 'contracted'
  isDisabled: text('is_disabled').notNull(), // '0' | '1'
  // 運営者(プラットフォーム管理)org フラグ。'1' の org の admin だけが
  // /api/organizations* 等の管理 API を使える(テナント admin は不可)。
  // 既定 '0' はアプリ層で設定(DDL DEFAULT 禁止の規約)。
  isOperator: text('is_operator').notNull(), // '0' | '1'
  createdAt: text('created_at').notNull(),
})

/** ログイン主体。1 org : N users。 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  email: text('email').notNull().unique(),
  // hmac$<base64>。招待未受諾は null(パスワード未設定)。
  passwordHash: text('password_hash'),
  role: text('role').notNull(), // 'admin' | 'staff'
  createdAt: text('created_at').notNull(),
})

/** 招待(tokenHash + 期限 72h、受諾で consumed)。 */
export const invitations = sqliteTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(), // SHA-256 hex
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'), // 受諾時刻(未受諾は null)
    createdAt: text('created_at').notNull(),
  },
  // 受諾時の token 照合が唯一のホットな検索(全走査を防ぐ)。
  (t) => [index('invitations_token_hash_idx').on(t.tokenHash)],
)

/** refresh トークン(30日・ローテーション + 再利用検知)。平文は保存しない。 */
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    organizationId: text('organization_id').notNull(),
    tokenHash: text('token_hash').notNull(), // SHA-256 hex
    expiresAt: text('expires_at').notNull(),
    rotatedTo: text('rotated_to'), // ローテーション後の後継 token id(使用済みの印)
    revokedAt: text('revoked_at'), // 明示 revoke / 再利用検知での失効時刻
    createdAt: text('created_at').notNull(),
  },
  // token_hash: 最頻の認証パス(/api/auth/refresh)の検索。user_id: 再利用検知の
  // 全セッション revoke と期限切れ行の掃除。行は refresh のたび増えるので、
  // インデックス無しだと成長に比例して rows_read(無料枠 5M/日)を食い潰す。
  (t) => [
    index('refresh_tokens_token_hash_idx').on(t.tokenHash),
    index('refresh_tokens_user_id_idx').on(t.userId),
  ],
)

/** 認証イベント監査(ログイン成否・ロックアウト・refresh 再利用等)。 */
export const authEvents = sqliteTable(
  'auth_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id'), // 不明時(未知 email 等)は null
    email: text('email').notNull(),
    kind: text('kind').notNull(), // login_success / login_failure / lockout / refresh_reuse ...
    ip: text('ip'),
    createdAt: text('created_at').notNull(),
  },
  // 日次 Cron の保持期間掃除(created_at < cutoff の DELETE)用。
  (t) => [index('auth_events_created_at_idx').on(t.createdAt)],
)
