# API 規約（Hono RPC + Zod）

- **Zod 単一ソース**: 入出力スキーマは `packages/contracts` に定義。バックは `zValidator('json', Schema)`、フロントは同じスキーマで検証（`safeParse`）。手書き型・`any` 禁止（`unknown` + Zod）。
- **ルートはチェーンする**: `const routes = app.get(...).post(...)`。`export type AppType = typeof routes`。バラ書き（`app.get(...)` を別文）は RPC 型に載らない。
- **`zValidator` はルート内インライン**に置く（`app.use` ではなく）。でないと `c.req.valid()` とクライアント入力型が伝播しない。
- **クライアント**: `hc<AppType>('/')`（`hono/client`）。`AppType` は **type-only import**。SPA と API は同一 Worker・同一オリジンなので base は `'/'`、**CORS は書かない**。
- **レスポンスは契約でシリアライズ**: `c.json(Item.array().parse(rows))` — DB 行の形が契約とずれたら実行時に検知される。
- **エラー形状**: `app.onError` で HTTPException は透過、予期しない throw は `{ error: 'internal_error' }` + 500 + `console.error`。ハンドラ内で握りつぶさない。
- **認可の層**（実装は `packages/shared/src/auth-server.ts`。自前で JWT を検証し直さない）:
  - **default-deny**: `app.use('/api/*', except(['/api/health', '/api/auth/*', '/api/internal/*'], ...))` で `/api/*` 全体にゲートを掛ける。**ルートを足しただけで保護される**のが要件 — 個別ルートに認証を足して回らない。
  - `tenantAuth()` — access JWT を検証し `c.var.auth`（`sub`/`org`/`email`/`role`）を確立。無 / 不正 / **期限切れは 401**。以後のクエリは `c.get('auth').org` でテナントスコープ。
  - `requireActiveOrg(resolver)` — org 同期行を毎リクエスト解決。行が無ければ **503 `not_synced`**（リトライで回復し得る）、無効化は **403 `org_disabled`**。`plan` はここで載せる（JWT クレームに入れない = 変更が即時反映）。
  - `requireRole(role)` / `requirePlan(plan)` — 権限不足は **403**。`requirePlan` は role による免除をしない（テナント管理者に課金機能を素通りさせない）。
  - Worker 間内部 API → `/api/internal/*` + `x-internal-key`（service binding 経由。**キー未設定時は fail close**）。テナントの JWT では越えられない。
  - 401（未認証・期限切れ）と 403（権限不足）を**取り違えない** — クライアントの再ログイン判定がこの区別に依存する。テストは `docs/testing/TEST_RULE.md` の権限マトリクスに従う。
- REST を増やすより RPC ルートを足す。例外的な生エンドポイント（health / dev トークングラント等）のみ素の Hono ルート可。
- **型推論が重くなったら**（ルートが数十本規模）: Hono 公式の対策 — TS project references か `hcWithType`（コンパイル済みクライアントのエクスポート）を導入する。それまでは足さない。
