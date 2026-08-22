# Agent がカジュアルに開発できる体制

このリポジトリは AI コーディングエージェント（Claude Code / Cursor / Codex / Copilot）が安全に・低摩擦で開発できるよう整えてある。

## 単一ソースの指示
- **`AGENTS.md`**（ルート）= 全エージェント共通の指示（[agents.md](https://agents.md/) 標準）。各 `services/*/AGENTS.md` はそのscopeの追加指示。Cursor / Codex は階層に応じて読む。
- **`CLAUDE.md`** = 同階層の `AGENTS.md` への**シンボリックリンク**（実体は 1 つ。各サービスにもscope固有の組がある）。
- **`.github/copilot-instructions.md`** = Copilot 向けポインタ。
- 重複は持たせない（ルート規約はルートAGENTS、サービス固有規約は各サービスAGENTSが正）。詳細規約は**タスク別ロードガイド**から必要時のみ読む（progressive disclosure — 命令数を増やすほど遵守率は下がる）。

## 完了の定義（最重要）
**`pnpm check`**（lint + Knip dependency audit + typecheck + combined test）が緑＝完了。combined
test は Worker/integration、React `test:web`、coverage、Approved UC/AC のE2E traceabilityを
含む。エージェントはこの pass/fail を頼りに無人で回せる。`make check` でも可。

## デザインの品質をどう担保するか（2 層）
1. **機構（決定論）**: 色・フォントは `packages/ui/src/theme.css` のトークン経由のみ。任意値・デフォルトパレットはレビューで拒否。
2. **プロンプト（規約）**: `docs/frontend/DESIGN_RULE.md` — NEVER/INSTEAD 表（既知の「AI 顔」収束点を列挙）+ トークン計画→自己批評→実装の 2 パス強制。UI タスクでのみロード。

## ツール
- **Cloudflare docs MCP**: Claude Code は `.mcp.json`、Codex は `.codex/config.toml` を読む（read-only）。最新の Workers/Wrangler 仕様を確認でき学習データの陳腐化を防ぐ。書き込み系 MCP は意図的に未同梱（必要なら各自のユーザー設定へローカル登録し、リポジトリにはコミットしない）。
- **リポジトリ固有スキル**（`.agents/skills/`）: `check`、`new-service <name>`、`design-select`。Claude Code は `.claude/skills` の symlink から同じ実体を読む。
- **toolchain ピン**: `mise.toml`（Node 22 / pnpm 11）。`mise install`。
- **hooks**（`lefthook.yml`）: pre-commitにBiome+combined test、commit-msgにcommitlint、pre-pushにlint+dependency audit+typecheck+combined test。「必ず守らせたいこと」はプロンプトでなくhookに置く。

## ワークフロー（推奨ループ）
1. **Issue**: `.github/ISSUE_TEMPLATE/agent-task.yml`（Goal / 受け入れ基準 / スコープ / DoD）。受け入れ基準がそのままテストになる。
2. **Spec**: 挙動が変わるなら `specs/<service>/features/<NNN>-<slug>/spec.md`（1 ファイル、`docs/spec-workflow/SPEC_WORKFLOW.md`）。
3. **TDD**: Worker/API、React、共有UIを問わずテスト先行（期待した理由でRedを確認）→ 実装 → `pnpm check` 緑。React service は `test`、`test:web`、`test:all` を使い分ける。
4. **E2E traceability**: Approved `spec.md` の UC/AC は実 Playwright scenario に `@e2e-covers` で一意に対応付け、`pnpm run test:traceability` を通す。infrastructure-only で UC/AC がない文書は分母外。詳細は [`E2E_TRACEABILITY.md`](../testing/E2E_TRACEABILITY.md)。
5. **PR**: Conventional Commits、US-ID 明記、CI（verify = agent compatibility + lint + dependency audit + typecheck + combined test）必須。e2e は手動トリガ（`workflow_dispatch`）またはローカルでオンデマンド。
6. **依存更新**: [`dependency-management.md`](./dependency-management.md) に従い、Knipで不要/暗黙依存を検査する。Renovateは安全なdev依存だけ自動化し、catalogとmajorは人間レビュー。

## 並行開発（git worktree）
```sh
make worktree/new name=agent-1     # ../<repo>-worktrees/agent-1 に作成 + install
make worktree/rm  name=agent-1
```
`.wrangler/state`（ローカル D1/KV）は worktree ごとに隔離。dev ポートは `vite dev --port` で分ける。

## 本番前の注意
`INTERNAL_KEY`・`JWT_SECRET`・`AUTH_PEPPER` の secrets 設定が必須（未設定は fail close）。`AUTH_DEV_GRANT` は本番に設定しない（dev トークングラント無効化）。`docs/howto/deploy.md` 参照。
