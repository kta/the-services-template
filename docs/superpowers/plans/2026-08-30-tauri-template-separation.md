# Tauri Template Separation and PR Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR #4/#5 を `main` 上へ統合し、Web 専用と Web + Tauri の雛形を分離して、不要な native CI 負荷を排除した1件のPRを作る。

**Architecture:** PR #5 は PR #4 を包含するため、PR #5 の3コミットを統合ブランチへ移植し、`main` との競合を解消する。その完成状態から `example_service` をWeb専用へ戻し、native対応状態を `example_tauri_service` に分離する。サービス種別とCI対象は検査可能な明示的境界にし、生成スキルはコピー前の二択を必須にする。

**Tech Stack:** pnpm 11、TypeScript、Node test runner、Vitest、Cloudflare Workers/Hono/D1、React/Vite、Rust 1.88、Tauri v2、GitHub Actions

**Spec:** `docs/superpowers/specs/2026-08-30-tauri-template-separation-design.md`、`specs/infra/features/002-tauri-template-separation/spec.md`

## Global Constraints

- API契約はZod単一ソース、Hono RPC、DBクエリはorganization_idでスコープする。
- Web専用サービスはTauri資産・依存・scriptsを持たない。
- TauriサービスだけをRust/Tauri CIの対象とする。
- 新サービス作成時はコピー前に「Webのみ / Web + Tauri」を質問する。
- production codeの挙動変更は、期待した理由で失敗するテストを先に確認する。
- push前に`pnpm check`、対象E2E、Rust/Tauri検証をgreenにする。
- コミット、push、PR本文にはConventional CommitsとUS-TPL-01/US-TPL-02を使用する。

---

### Task 1: PR #5 の統合と競合解消

**Files:**
- Modify: PR #5 が変更する既存ファイル一式
- Create: PR #5 が追加するファイル一式

**Interfaces:**
- Consumes: `origin/review/pr-4-followups` のコミット `c6e9704`、`cabda2b`、`7002172`
- Produces: `origin/main` 上でPR #4/#5の機能を保持した統合済みworking tree

- [ ] **Step 1: 仕様文書を退避可能なpatchとして確認する**

Run: `git diff -- docs/superpowers/specs specs/infra/features`

Expected: 承認済み設計とspecだけが表示される。

- [ ] **Step 2: PR #5の3コミットを古い順にcherry-pickする**

Run: `git cherry-pick c6e9704 cabda2b 7002172`

Expected: `main` 由来の変更箇所で競合し、未解決ファイルが明示されるか、3コミットが適用される。

- [ ] **Step 3: 競合を意味論で解消する**

`main` で追加されたCloudflare production導線とPR #5のsecurity hardeningを両立させる。生成済みlockfileやmigrationは片側を機械的に選ばず、package定義・schema・journalとの整合を確認する。

- [ ] **Step 4: 統合状態の狭い検査を実行する**

Run: `git diff --check && pnpm install --lockfile-only && pnpm run typecheck`

Expected: whitespace errorなし、lockfile整合、typecheck成功。

### Task 2: 雛形境界のテストをRedにする

**Files:**
- Modify: `scripts/check-tauri-boundary.test.mjs`
- Modify: `scripts/check-agent-compat.test.mjs` または既存のagent互換テスト
- Modify: workflow/Makefile整合性を検査する既存test

**Interfaces:**
- Consumes: repository root pathを受ける既存boundary checker
- Produces: Web専用/Tauri対象/生成質問/CI対象の不整合を検出するテストケース

- [ ] **Step 1: Web専用雛形の禁止資産テストを書く**

`services/example_service` に `src-tauri`、`@tauri-apps/*` dependency、`tauri:*` scriptのいずれかがあれば失敗するfixtureを追加する。

- [ ] **Step 2: Tauri雛形の必須資産テストを書く**

`services/example_tauri_service` からCargo manifest、tauri.conf、capability、native transport、release originのいずれかを欠落させたfixtureが失敗することを追加する。

- [ ] **Step 3: new-serviceの質問契約テストを書く**

`new-service/SKILL.md` がコピー前の二択質問、`example_service`/`example_tauri_service`の対応を持たないfixtureを失敗させる。

- [ ] **Step 4: CI対象分離テストを書く**

通常verifyのRust commandに`example_service`が含まれる場合、および`example_tauri_service`がTauri対象から欠ける場合に失敗させる。

- [ ] **Step 5: Redを確認する**

Run: `node --test scripts/check-tauri-boundary.test.mjs` と対象のagent/workflow test

Expected: 新しいassertionが、未分離の雛形または未実装の質問契約を理由にFAILする。

### Task 3: Web/Tauri雛形を分離する

**Files:**
- Create: `services/example_tauri_service/**`
- Modify: `services/example_service/**`
- Modify: `pnpm-workspace.yaml`, `package.json`, `knip.jsonc`
- Modify: `services/example_tauri_service/package.json`
- Modify: `services/example_tauri_service/src-tauri/tauri*.conf.json`
- Modify: `services/example_tauri_service/wrangler.jsonc`

**Interfaces:**
- Consumes: PR #5統合後のTauri対応`example_service`
- Produces: `@app/example_service`（Web専用）と`@app/example_tauri_service`（native対応）

- [ ] **Step 1: 統合後のexample_serviceをexample_tauri_serviceへ複製する**

生成物、`node_modules`、`.wrangler`、coverage、Playwright artifacts、local secretsを除外し、tracked sourceだけを複製する。

- [ ] **Step 2: Tauri雛形をリネームする**

package名、Worker名、D1名、dev/e2e port、Tauri productName/identifier、storage key、workflow入力、ドキュメント参照を`example_tauri_service`へ変更する。契約のitem schemaは既存example契約を再利用し、重複した手書き型を作らない。

- [ ] **Step 3: example_serviceからnative専用資産を除去する**

`src-tauri`、Tauri Vite config、Tauri dependencies/scripts、native session/transport分岐を削除し、Web sessionStorageとsame-origin Hono RPCだけを残す。

- [ ] **Step 4: 両サービスの型とunit testをGreenにする**

Run: `pnpm --filter @app/example_service test:all && pnpm --filter @app/example_tauri_service test:all && pnpm --filter @app/example_service typecheck && pnpm --filter @app/example_tauri_service typecheck`

Expected: 全成功。

### Task 4: 生成質問とCI対象を実装する

**Files:**
- Modify: `.agents/skills/new-service/SKILL.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/example-tauri-build.yml` または統合後のTauri workflow
- Modify: `Makefile`
- Modify: `package.json`
- Modify: `scripts/check-tauri-boundary.mjs`
- Modify: `scripts/check-tauri-boundary.test.mjs`
- Modify: `AGENTS.md`, `README.md`, `CODEMAP.md`, `docs/howto/tauri-example-service.md`

**Interfaces:**
- Consumes: 2つの完成形雛形
- Produces: コピー前の`Web only | Web + Tauri`選択契約、Tauri対象だけを処理するCI/Make導線

- [ ] **Step 1: new-serviceスキルへ必須質問を実装する**

名前だけが与えられた場合も、コピー前に種別を質問する。Webを推奨既定値として説明し、回答別にコピー元、除外、リネーム、検証コマンドを完全に分岐する。

- [ ] **Step 2: boundary checkerを最小実装する**

Web専用禁止資産とTauri必須資産を静的に検査し、サービス名を含むactionable errorを返す。

- [ ] **Step 3: CIとMakefileをTauri対象へ限定する**

Rust fmt/test/clippy、Tauri static/build workflow、native Make targetから`example_service`を外し、`example_tauri_service`を登録する。通常TypeScript gateとE2Eは両雛形の必要範囲を維持する。

- [ ] **Step 4: ドキュメントを二雛形方式へ更新する**

新サービス作成、Tauri開発、CIコスト、exampleが本番deploy対象外であることを一貫して記載する。

- [ ] **Step 5: Redだった境界テストをGreenにする**

Run: `node --test scripts/check-tauri-boundary.test.mjs` とTask 2で選んだagent/workflow test

Expected: 全成功。

### Task 5: 回帰検証とTauri実機相当検証

**Files:**
- Modify: テストで発見した欠陥に対応するファイルのみ

**Interfaces:**
- Consumes: 統合・分離済みrepository
- Produces: 全品質ゲートの証跡

- [ ] **Step 1: 両exampleのE2Eを実行する**

Run: `pnpm --filter @app/example_service e2e` と `pnpm --filter @app/example_tauri_service e2e`

Expected: 全Playwright test成功、traceability重複なし。

- [ ] **Step 2: Rust品質ゲートを実行する**

Run: `cargo fmt --check --manifest-path services/example_tauri_service/src-tauri/Cargo.toml && cargo test --locked --manifest-path services/example_tauri_service/src-tauri/Cargo.toml && cargo clippy --all-targets --manifest-path services/example_tauri_service/src-tauri/Cargo.toml -- -D warnings`

Expected: 全成功。`example_service`にはCargo manifestが存在しない。

- [ ] **Step 3: Tauri static/native build導線を実行する**

Run: repositoryのMakefileで確定した`build/example_tauri_service/tauri`相当とartifact secret scan

Expected: build成功、secret検出なし。

- [ ] **Step 4: 全チェックを実行する**

Run: `pnpm check`

Expected: lint、Knip、typecheck、coverage、traceabilityが全て成功。

### Task 6: Subagent二段階レビューと修正

**Files:**
- Modify: レビュー指摘に必要なspec/test/implementation

**Interfaces:**
- Consumes: `origin/main...HEAD`の全差分と検証結果
- Produces: 重大・高重要度指摘ゼロのレビュー結果

- [ ] **Step 1: 仕様適合subagentレビューを依頼する**

設計、Approved spec、PR #4/#5本文、差分を照合し、欠落、余計なスコープ、受け入れ基準未達を重要度付きで報告させる。

- [ ] **Step 2: 品質・セキュリティsubagentレビューを依頼する**

JWT鍵境界、session失効、internal key、tenant isolation、deploy/bootstrap、secret/artifact、Tauri IPC/origin/capability/CSP、migration/backup/restore、workflow権限と負荷をレビューさせる。

- [ ] **Step 3: 指摘をTDDで修正する**

挙動欠陥は再現テストをRedにしてから修正する。誤検知は根拠を記録し、重大・高重要度の未解決を残さない。

- [ ] **Step 4: 修正後の再レビューと全チェックを行う**

Run: 関連狭域test、`pnpm check`、影響したE2E/Rust/Tauri検証

Expected: 全成功、subagent再レビューで重大・高重要度指摘なし。

### Task 7: コミット・push・統合PR・旧PR整理

**Files:**
- Modify: Git history、GitHub PR state

**Interfaces:**
- Consumes: 検証・レビュー済みworking tree
- Produces: 1件の統合PR、旧PR #4/#5からの明確な移行先

- [ ] **Step 1: verification-before-completionを実行する**

差分、status、全検証ログ、spec AC、レビュー指摘解消を要件ごとに再確認する。

- [ ] **Step 2: Conventional Commitsで論理的にコミットする**

例: `feat(templates): separate web and Tauri service examples`、本文またはPRへ`US-TPL-01 US-TPL-02`を記載する。secretと生成物が含まれないことを確認する。

- [ ] **Step 3: 統合ブランチをpushする**

Run: `git push -u origin feat/consolidate-tauri-templates`

Expected: pre-push gate成功、remote branch作成。

- [ ] **Step 4: 統合PRを作成する**

base=`main`、head=`feat/consolidate-tauri-templates`。PR #4/#5の統合、US-TPL-01/02、設計判断、検証結果、レビュー結果を本文へ記載する。

- [ ] **Step 5: PR状態を確認して旧PRをクローズする**

新PR URLとhead SHAを確認後、PR #4/#5へ移行コメントを付けてクローズする。新PRが作成できなければ旧PRは閉じない。
