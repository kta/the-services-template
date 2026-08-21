# DB 規約（Drizzle + D1）

- **1ドメイン = 1 D1**。cross-D1 JOIN 禁止 → アプリ層で集約/同期（service binding + 日次照合 Cron）。
- **FK は宣言しない**。整合性はアプリ層（必要なら明示的な存在チェック）。
- **ID はアプリ生成**（`crypto.randomUUID()` = UUID v4）。DB 生成 ID（AUTOINCREMENT 等）禁止。意味を持つ既定値（時刻・状態・フラグ）はアプリ層で設定し DDL DEFAULT に置かない（自明な空文字既定など、値にロジックが無いものは可 — 例: example_service `items.body`）。時間順ソートは ID に頼らず `created_at`（v4 は k-sortable ではない）。
- **テナント列**: 全ドメインテーブルに `organization_id`、全クエリでスコープ（JWT の `org` から）。
- **トランザクション無し**: D1 に対話的 tx は無い。原子性が要る複数文は `db.batch([...])`（失敗で全ロールバック）。それ以外は冪等設計で。
- **マイグレーション**: `src/worker/db/schema.ts` を編集 → `pnpm db:generate`（drizzle-kit）→ `pnpm db:migrate:local` / `:remote`（`wrangler d1 migrations apply`）。`drizzle.config.ts` の `out` と wrangler の `migrations_dir` は一致（`./migrations`）。`drizzle-kit migrate` は使わない。
- **接続プール無し**: D1 はバインディング経由。`drizzle(c.env.DB)` をハンドラ内で生成。
- **読み取りスケールが要るとき**: D1 read replication（Sessions API, `env.DB.withSession(bookmark)`）を検討。テンプレでは未実装（YAGNI）。
