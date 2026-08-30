# Tauri テンプレート分離・PR 統合設計

## 目的

PR #4 と、その全コミットを含む PR #5 を `main` 上で再統合し、Web 専用サービスへ Tauri のビルド負荷が波及しないサービス雛形へ再構成する。新サービス作成時には Web 専用か Web + Tauri かを人間に確認し、選択した完成形テンプレートだけをコピーする。

## 統合方針

- `main` を基点とする統合ブランチへ PR #5 の変更を取り込み、競合を解消する。PR #5 は PR #4 の全コミットを含むため、PR #4 を別途重ねない。
- PR #5 に含まれる非対称 JWT、セッション失効、方向別 internal key、production deploy/bootstrap、backup/restore、artifact 検査も統合・レビュー対象とする。
- ローカル実装と検証の完了後、利用者の一回限りの承認を得て push、新規統合 PR の作成、旧 PR #4/#5 のクローズを行う。

## テンプレート構成

### Web 専用

`services/example_service` は React SPA、Hono Worker、D1 の標準雛形とする。`src-tauri`、Cargo manifest、Tauri 用 npm scripts・依存、native transport、platform overlay を持たせない。

### Web + Tauri

`services/example_tauri_service` は Web 側のドメイン機能に加え、Tauri desktop/iOS/Android shell、許可リスト式 native transport、native auth storage、固定 release origin、capability、CSP、platform overlay を持つ独立した完成形雛形とする。

両雛形は生成後に単独で理解・検証できることを優先する。差分 overlay 方式は生成処理と検証が複雑になるため採用しない。

## 新サービス作成インターフェース

`.agents/skills/new-service/SKILL.md` は、サービス名の確認に加えて、コピー前に次のどちらかを必ず質問する。

1. Web のみ（推奨・デフォルト）
2. Web + Tauri

回答前にサービスをコピーしてはならない。Web のみなら `services/example_service`、Web + Tauri なら `services/example_tauri_service` をコピーし、選択に固有のリネーム・検証手順を適用する。

## CI 境界

- TypeScript lint、dependency audit、typecheck、unit/integration、web coverage、traceability は従来どおり対象パッケージへ適用する。
- Rust fmt/test/clippy、Tauri boundary、native static build は Tauri 対応サービスだけへ適用する。
- Web 専用サービスに `src-tauri`、Tauri dependency、Tauri package script が混入した場合は境界テストを失敗させる。
- Tauri 対応サービスに必須の Cargo/config/capability/origin/transport が欠けた場合も境界テストを失敗させる。
- macOS/iOS/Android の重い artifact build は通常 PR の必須 verify に含めず、手動 workflow または明示された対象変更時の導線に限定する。
- CI、Makefile、検査スクリプト間の対象一覧は、現行構造を崩さない範囲で単一ソース化し、登録漏れをテストする。

## テスト戦略

TDD で、先に次の失敗を確認する。

- Web 専用テンプレートが Tauri 資産を含む場合に失敗する。
- Tauri テンプレートの必須資産・設定が欠けた場合に失敗する。
- 新サービススキルが種別質問とコピー元の対応を欠く場合に失敗する。
- CI が Web 専用テンプレートへ Rust/Tauri 検査を適用する場合に失敗する。
- Tauri 対象の workflow・Make target・package script の登録が不整合なら失敗する。

対象 unit/integration、両 example の E2E、Rust fmt/test/clippy、Tauri static build、最後に `pnpm check` を実行する。実時刻、認証権限、テナント分離、best-effort fallback は既存の境界テストを維持する。

## レビュー

実装後は subagent を用いて二段階レビューを行う。

1. 仕様適合レビュー: 本設計、Approved spec、PR #4/#5 の目的に対する欠落・余計な変更を確認する。
2. 品質・セキュリティレビュー: JWT 鍵境界、session introspection、internal key、テナント分離、deploy/bootstrap fail-close、secret/artifact、Tauri IPC/origin/capability/CSP、migration/backup/restore、CI 権限と負荷を確認する。

指摘は重要度順に修正し、挙動上の欠陥には先に再現テストを追加する。修正後に同じ観点で再レビューし、未解決の重大指摘を残さない。

## 完了条件

- Web 専用と Web + Tauri の完成形雛形が独立して存在する。
- 新サービス作成時に種別が必ず確認される。
- Web 専用サービスに native CI オーバーヘッドが生じない。
- PR #4/#5 の統合差分が `main` 上で競合なく検証される。
- `pnpm check`、対象 E2E、Rust/Tauri 検証が緑である。
- subagent レビューの重大・高重要度指摘が解消される。
- 利用者の承認後に統合 PR が1件作成され、旧 PR #4/#5 がその PR を参照してクローズされる。
