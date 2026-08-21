# 横断仕様: shared

全サービスに共通する関心事。実装は `packages/{contracts,ui,shared}` と `services/notifier`。

## 型・契約（`packages/contracts`）
Zod を単一ソースに、ドメインごと `src/<service>.ts`。バックは `zValidator`、フロントは `z.infer` で共有。手書き型・`any` 禁止。

## 認証（`packages/shared`）
- 自前 JWT（HS256、access 15 分）+ 不透明 refresh（HttpOnly cookie、ローテーション + 再利用検知）。パスワードは**クライアント側 PBKDF2 600k + サーバ pepper HMAC**（Workers CPU 10ms 対応、`password.ts`）。
- hono ミドルウェア: `tenantAuth` / `requireActiveOrg`（未同期 503 / 無効化 403）/ `requireRole` / `requirePlan`（`auth-server.ts`）。認証源泉は admin サービス（login / 招待 / ロックアウト）。
- dev は `/api/auth/token`（dev グラント、`AUTH_DEV_GRANT` fail-close）。**本番は未設定 = 無効**。

## 通知（`services/notifier` — Queue なし・無料枠）
- 呼び出し側（各サービス）→ `sendNotification`（@app/shared）で notifier の `POST /api/internal/send` に **service binding 同期 POST**（best-effort）。
- notifier: KV `DEDUPE` で冪等（`job.id`、TTL 24h）+ Resend idempotency-key。送信は pluggable（Log / Resend）。
- DLQ の代替は UI フォールバック / 再検知 Cron（`docs/howto/notifications.md`）。Cron（UTC）。

## 解析（`packages/shared/src/analytics.ts`）
GA4 `trackEvent` + 中央レジストリ `ANALYTICS_EVENTS`（snake_case・PII 禁止）。未設定環境では no-op。

## UI（`packages/ui`）
共有デザインシステム（components + tokens CSS）。両 SPA が `@app/ui` を利用。

## 規約（`AGENTS.md` / `docs/`）
SDD（Specify→Plan→Tasks→Implement）・TDD（テスト先行）・テナントスコープ強制・1サービス1 D1・cross-D1 JOIN 禁止・secrets は `wrangler secret put`。
