# AGENTS.md

AI コーディングエージェント（Claude Code / Cursor / Codex / Copilot）向けの単一ソース。ツール固有ファイルはこれを指す（`CLAUDE.md` は**このファイルへのシンボリックリンク**、`.github/copilot-instructions.md` はポインタ）。人間向けの入口は [`README.md`](./README.md)。

ルート共通規約はこのファイルを読む。`services/*` で作業するときは、その階層の `AGENTS.md` も
追加適用する。詳細規約は末尾の「タスク別ロードガイド」から**必要なときだけ**読む。

## プロジェクト概要
Cloudflare-only の SDD/TDD モノレポ **テンプレート**。**1 サービス = 1 Worker が React SPA と Hono API を同一オリジンで配信**し、ドメインごとに D1(SQLite) を持つ。型は **Zod 単一ソース + Hono RPC**、デザインは **`packages/ui` のトークン単一ソース**。**全スタックが Cloudflare 無料枠で動く**（Queues 等の Paid 機能は不使用。通知は service binding の同期送信 API）。IaC は Terraform + Wrangler。`services/example_service` を雛形に新サービスを増やす。

アーキテクチャの構成・責務・主要フローは [`CODEMAP.md`](./CODEMAP.md) を参照。

## セットアップ / コマンド
- 必要: Node ≥ 22 / pnpm 11（`mise install` でピン）。
- `make init` — install + `.dev.vars` 生成 + 型生成 + ローカル D1 マイグレーション + seed（admin ユーザー等）。
- dev: `make dev/example_service`（:5173）/ `make dev/admin`（:5174）/ `make dev/notifier` / `make dev/all`（admin + example_service 併走。service binding が dev サーバ間でも解決される）。**1 コマンドで SPA + Worker**（`@cloudflare/vite-plugin`、実 workerd、proxy 無し）。
- DB: スキーマ編集 → `pnpm --filter <pkg> db:generate` → `db:migrate:local`。
- バインディング / `wrangler.jsonc` 変更後は `pnpm -r cf-typegen`。
- ターゲット一覧は `make help`。

## 完了の定義（必ず緑にする）
- **`pnpm check`**（= `make check`）= lint(Biome) + dependency audit(Knip) + typecheck + combined test（Worker/unit + React web + coverage + E2E traceability）。**実装後に必ず通す。**
- React service は `test`（Worker）、`test:web`（jsdom）、`test:all`（両方）。root `pnpm test` は React service の `test:all` を各 1 回だけ明示実行する。
- 1 テストに絞る: `pnpm --filter <pkg> exec vitest run -t "<name>"`（web は `--config vitest.web.config.ts` を加える）。
- e2e（Playwright）は `pnpm --filter <pkg> e2e`。**CI では手動トリガのみ**（`workflow_dispatch`）なので、UI を変えたらローカルで回す。

### 品質ゲートの所在（重要）
| タイミング | 実行内容 | 効果 |
|---|---|---|
| **pre-commit**（`lefthook.yml`） | 変更ファイルの lint/format 自動修正 → **combined test**（Worker/web coverage + traceability） | 早期ローカルフィードバック（落ちたらコミット不可） |
| **pre-push** | Biome check + Knip dependency audit + typecheck + **combined test** | 早期ローカルフィードバック（落ちたら push 不可） |
| **CI `verify`**（`.github/workflows/ci.yml`） | agent compatibility + lint + dependency audit + typecheck + **combined test** | PR / main の最終リモートゲート。`deploy` の前提 |

Lefthook は開発中の早期フィードバック、CI `verify` は迂回できない最終リモートゲートである。`--no-verify` / `LEFTHOOK=0` は緊急時の一回限りとし、常用しない。e2e は UI 変更時にローカルで実行し、CI では手動トリガ（`workflow_dispatch`）のみとする。

## テストの厚み（どこを手厚く書くか）
「動く」ことより**壊れ方が静かな領域**を厚く。以下は**必ず境界値まで**書く（薄いと指摘対象）:

1. **時刻・期限**: JST 日跨ぎ / 月・年跨ぎ / うるう年、トークン期限（ちょうど・±1 秒）、ローテーション猶予、招待の有効期限、Cron スロットキー（am/pm・日跨ぎ）、鮮度閾値。
   - **実時刻に依存させない**。時刻は必ず引数で注入する（`AuthConfig.now` / `now: Date` / `signAccessToken(..., now)`）。`Date.now()` に依存したテストは書かない。
2. **権限（ユーザーによって変わるもの）**: ロール（admin / staff）× 運営 org / テナント org × 未認証 / 期限切れ / 別 secret 署名 を**表駆動で全エンドポイント**。新ルートを足したら表に 1 行足す（default-deny の証明として未知パスも入れる）。
3. **テナント分離**: 複数テナントを同時に動かし、他テナントのデータが**見えない・書き換えられない・偽装入力で越境できない**ことを確認。1 サービスにつき最低 1 本は必須。
4. **失敗時のフォールバック**: 通知失敗・同期失敗・KV 障害など「best-effort が握りつぶす」経路は、握りつぶした事実（ログ・戻り値・冪等キーの有無）まで検証。

配置: 境界値の網羅は `*.time.test.ts` / `permissions.test.ts` / `tenant-isolation.test.ts` のように**代表フローの integration テストと分ける**（読みやすさとカバレッジの意図が明確になる）。詳細は `docs/testing/TEST_RULE.md`。

## 絶対ルール（毎タスク非交渉）
1. **SDD**: 挙動が変わる変更は spec 先行（`docs/spec-workflow/SPEC_WORKFLOW.md`）。軽微変更（バグ修正・文言・リファクタ）は免除。曖昧は `[要確認: ...]` を残し解消まで進まない。
2. **TDD**: 実装より先にテスト。Red→Green→Refactor。Worker/APIだけでなくReact frontendと共有UIも対象とし、挙動を追加・変更するproduction codeは、期待した理由で失敗するテストを先に確認してから書く。
   - frontend unit coverageはlines / statements / functions / branchesの各指標で**60%以上**、backend unit/integration coverageは各指標で**80%以上**を下限とする。下限を満たすための広範な除外や閾値引き下げは禁止。
   - E2Eの「100%」はline coverageではなく、Approved `specs/**/spec.md` の全Use Case / Acceptance Criteriaがちょうど1本のE2Eへ追跡可能であることを指す。`pnpm run test:traceability` と [`docs/testing/E2E_TRACEABILITY.md`](./docs/testing/E2E_TRACEABILITY.md) の convention を維持し、未対応・未知・重複UC/ACを残さない。infrastructure-only でUC/ACを持たない文書は分母外である。
   - push直前はローカルでcombined coverage gate、traceability validator、変更した挙動の対象E2Eを実行する。未達・失敗時はpushせず、テストまたは実装を修正して全gateを再実行する。
3. **型は派生物**: API 契約は **Zod 単一ソース**（`packages/contracts/src/<service>.ts`）。手書き型・`any` 禁止（`unknown`+Zod）。バックは `zValidator` インライン、フロントは `hc<AppType>`（type-only import）。
4. **API は Hono RPC**: ルートは**チェーン**して `export type AppType = typeof routes`。同一オリジンなので CORS を書かない。
5. **デザインはトークン経由のみ**: 色・フォント・角丸は `packages/ui/src/theme.css` のセマンティックトークンだけ。**Tailwind デフォルトパレット（`bg-blue-500`）・任意値（`p-[13px]`・`text-[#hex]`）禁止**。UI 作成/変更時は `docs/frontend/DESIGN_RULE.md` に従う（2 パス設計）。
6. **テナントスコープ強制**: 全 DB クエリを `organization_id`（JWT の `org`）でスコープ。
7. **DB = Drizzle + D1**: FK 宣言しない。ID はアプリ生成（`crypto.randomUUID()`）。原子性は `db.batch()`。マイグレーションは `drizzle-kit generate` → `wrangler d1 migrations apply`（`out` == `migrations_dir` == `./migrations`）。
8. **ドメイン分離**: 1 サービス = 1 Worker + 1 D1。**cross-D1 JOIN 禁止** → service binding でアプリ層同期（admin が源泉 → 各ドメインへ upsert + 日次照合 Cron）。
9. **完全無料枠で動かす**: Workers Paid が必要な機能は設計に含めない。通知・非同期は **notifier への同期送信 API（service binding + `x-internal-key`）+ KV 冪等キー（TTL 24h）+ 再検知 Cron / UI フォールバック**（`docs/howto/notifications.md`）。**Queues は Free でも使える**（2026-02〜: 10,000 ops/日・保持 24h）が、**このテンプレートは採用しない**（部品を増やさず上記で足りるという設計判断 — 採用はルール 10 の人間承認事項）。無料枠上限と設計対処は `docs/howto/free-tier-limits.md`。Cron は UTC（JST の意図をコメントに残す）。
10. **同意なしに決めない**: アーキ変更・ライブラリ追加・仕様外機能は人間承認。
11. **secrets は `wrangler secret put`**（コード / TF state / `wrangler.jsonc` の `vars` に置かない）。dev 値は各サービスの `.dev.vars`（gitignore 対象）のみ。

## サービス境界
| パッケージ | 種別 | dev port | 役割 |
|---|---|---|---|
| `services/example_service` (`@app/example_service`) | SPA+API Worker + D1 | 5173 | item ドメイン。**コピー元の雛形**（本番デプロイ対象外） |
| `services/admin` (`@app/admin`) | SPA+API Worker + D1 + KV | 5174 | organizations 源泉 + **認証源泉**（login/refresh/招待）。service binding で各ドメインへ org 同期 + 日次照合 Cron |
| `services/notifier` (`@app/notifier`) | 同期送信 API Worker + KV | — | 通知（`POST /api/internal/send`・KV 冪等・Resend）。送信手段未設定は **fail close(502)** |
| `services/ops` (`@app/ops`) | Cron + Workflows Worker + R2 | — | D1 バックアップ（R2 に世代保存）+ 鮮度/容量/死活監視。Workflows は無料枠内 |
| `packages/contracts` (`@app/contracts`) | TS | — | **Zod 単一ソース** |
| `packages/ui` (`@app/ui`) | TS/TSX + theme.css | — | **デザイントークン単一ソース** + 共有プリミティブ |
| `packages/shared` (`@app/shared`) | TS | — | 認証(JWT/password/hono ミドルウェア) / internal 呼び出し / JST 日付 / 解析(GA4) |

各サービスの中身: `src/worker/`（Hono + Drizzle schema）/ `src/web/`（React SPA）/ `migrations/` / `test/`（vitest-pool-workers）/ `e2e/`（Playwright）。ops・notifier は SPA/D1 を持たない（`src/` 直下に Worker のみ）。

## セキュリティ / やってはいけない
- ドメインクエリのテナントスコープを外さない。認証フロー（`packages/shared` の auth）を無断で変えない。
- secrets をコミットしない。`.dev.vars` は gitignore、本番は `wrangler secret put`。
- **本番前チェックリスト**（`INTERNAL_KEY` / `JWT_SECRET` / `AUTH_PEPPER` / `AUTH_DEV_GRANT` / `MAIL_FROM` 等）は [`docs/howto/deploy.md`](./docs/howto/deploy.md)。example_service は雛形なので本番デプロイしない（CI の deploy matrix 対象外）。

## コミット / PR
- **Conventional Commits**（commitlint + lefthook で強制。pre-commit=biome / pre-push=typecheck+test）。
- PR に **US-ID / タスク ID** を明記。`pnpm check` 緑が前提。コミット・push はユーザーが明示的に依頼したときだけ。デフォルトブランチでの作業はまずブランチを切る。

## エージェント固有メモ
- **Claude Code**: 次の場合は **plan mode** で計画してから着手 — ①新サービス追加 ②DB スキーマ変更 ③ライブラリ追加・置換 ④仕様外/横断的なリファクタ ⑤認証・通知・service binding に触れる変更。
- **リポジトリ内スキル**（`.agents/skills/`）: `check`（`pnpm check` を緑まで）/ `new-service <name>`（サービス雛形）/ `design-select`（デザイン候補を HTML でブラウザ提示→クリックで選択）。Claude Code は `.claude/skills` の symlink から同じスキルを利用する。
- **新規画面・見た目の大幅変更**では、コードの前に `docs/frontend/DESIGN_RULE.md` のパス 1（トークン計画）をテキストで出し、`design-select` スキルで候補 2〜3 案を見せてから実装する。
- **新 API は当て推量しない**: Cloudflare は Claude Code の `.mcp.json` または Codex の `.codex/config.toml` にある `cloudflare-docs` MCP、ライブラリ全般は `context7` MCP（**導入している場合**。未導入ならインストール済みパッケージの型定義・公式 docs で確認）。
- 並行作業は `make worktree/new name=<branch>` / `make worktree/rm name=<branch>`（`.wrangler/state` が worktree ごとに隔離される）。

## タスク別ロードガイド（必要なときだけ読む）
| 作業 | 必読 |
|---|---|
| UI を作る・変える | `docs/frontend/DESIGN_RULE.md`（**AI っぽい見た目の禁止事項と 2 パス設計**） |
| 新機能（挙動が変わる変更） | `docs/spec-workflow/SPEC_WORKFLOW.md` → `specs/<service>/features/<NNN>-<slug>/spec.md` |
| 新サービス追加 | `specs/README.md` + `.agents/skills/new-service` |
| API 追加 | `docs/api/API_RULE.md` |
| DB スキーマ変更 | `docs/database/DATABASE_RULE.md` |
| テスト | `docs/testing/TEST_RULE.md` |
| Cloudflare 初期設定を任される | `docs/howto/cloudflare-setup.md` |
| インフラ / デプロイ | `docs/architecture/infra.md` / `docs/howto/deploy.md` |
| 無料枠の上限・設計対処 | `docs/howto/free-tier-limits.md` |
| バックアップ / リストア | `docs/howto/restore.md` |
| 通知（Queue なし設計） | `docs/howto/notifications.md` |
| 開発体制・ワークフロー全体 | `docs/howto/agent-development.md` |
| 依存の追加・削除・更新 | `docs/howto/dependency-management.md` |
| LLM を組み込む機能**のみ** | `docs/security/AI_GUARDRAILS_RULE.md`（LLM を扱わないタスクでは読まない） |

## 注意
toolchain は新しめ。新 API は当て推量せず**インストール済みパッケージ / 公式 docs で確認**してから使う。
