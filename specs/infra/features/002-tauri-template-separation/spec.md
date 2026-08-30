- ステータス: Approved

# Tauri 対応サービス雛形の分離

## WHAT / WHY

Web 専用サービスまで native app として扱われる CI 負荷をなくすため、Web 専用と Web + Tauri の雛形を分離する。新サービス作成者はコピー前にサービス種別を選び、選ばなかった platform の資産や検査を引き継がない。

### Infrastructure goals

- TPL-GOAL-01: サービス作成者は、Web 専用か Web + Tauri かを明示して適切な雛形を生成できる。
- TPL-GOAL-02: 保守者は、Web 専用サービスの CI で不要な Rust/Tauri 処理が実行されないことを確認できる。

### Static acceptance requirements

この feature は生成スキルと静的 CI 境界を定義する infrastructure-only 文書であり、ブラウザ UI/API の product behavior ではない。以下の識別子は Playwright の `UC-*` / `AC-*` definition bullet にせず、実際に対象を実行する Node/shell boundary test と workflow 検査へ割り当てる。空の Playwright test や偽の `@e2e-covers` mapping は追加しない。

| ID | 要件 | 検証層 |
|---|---|---|
| `STATIC-TPL-01` | 新サービス名だけで開始しても Web only / Web + Tauri を質問し、回答前にはコピーしない。 | `scripts/check-agent-compat.test.mjs` |
| `STATIC-TPL-02` | Web only は `example_service` から生成し、Tauri 資産・依存・scripts を含めない。 | `scripts/check-agent-compat.test.mjs`, `scripts/check-tauri-boundary.test.mjs` |
| `STATIC-TPL-03` | Web + Tauri は `example_tauri_service` から生成し、native transport・固定 origin・capability・platform 設定を引き継ぐ。 | `scripts/check-agent-compat.test.mjs`, `scripts/check-tauri-boundary.test.mjs` |
| `CI-TPL-04` | 通常 PR verify で Web-only 雛形を Rust/Tauri 対象にしない。 | `scripts/check-deploy-boundary.test.mjs` |
| `STATIC-TPL-05` | Tauri 雛形の必須 native 資産欠落・security boundary 違反を検出する。 | `scripts/check-tauri-boundary.test.mjs` |
| `STATIC-TPL-06` | Web-only 雛形への Tauri 資産・依存・scripts 混入を検出する。 | `scripts/check-tauri-boundary.test.mjs` |
| `STATIC-TPL-07` | `deployable: false` の雛形を production build/deploy/D1/ops/admin domain binding の全 surface から除外し、production の domain binding 集合を catalog の `deployable: true` domain 集合と完全一致させる。雛形 binding がローカル開発に必要な場合は production config ではなく dev-only config で追加する。 | `scripts/service-wiring.test.mjs`, `scripts/check-production-config.test.mjs` |

### スコープ外

- Tauri の新規機能追加
- 自動署名、store 公開、自動リリース
- Web と Tauri の差分 overlay generator

## HOW

- `services/example_service`: Web 専用のコピー元。
- `services/example_tauri_service`: Web + Tauri のコピー元。
- `.agents/skills/new-service/SKILL.md`: 種別質問、コピー元、選択別の作業手順。
- CI workflow、Makefile、package scripts、Tauri boundary scripts: 対象を種別に応じて限定し、登録整合性を検査する。
- `service-catalog.json`: production surface と admin domain binding の単一ソース。`example_service` の開発用 binding は admin の Vite dev config だけで注入し、production `wrangler.jsonc` には残さない。
- API 契約・DB スキーマ差分: なし。既存の Zod/Hono RPC/D1 境界を維持する。
- 却下案: Web 雛形へ Tauri overlay を後付けする方式。生成ロジックと完成形検証が複雑になるため採用しない。

## TASKS

- [ ] T-001: 雛形種別、生成質問、CI 対象境界の失敗テストを追加して Red を確認する。
- [ ] T-002: PR #5 を `main` 基点の統合ブランチへ取り込み、競合を解消する。
- [ ] T-003: `example_service` を Web 専用、`example_tauri_service` を Tauri 対応として分離する。
- [ ] T-004: `new-service` スキルと関連ドキュメントを二択方式へ更新する。
- [ ] T-005: CI、Makefile、package scripts、境界検査をサービス種別に合わせる。
- [ ] T-006: 対象 unit/integration、E2E、Rust/Tauri、`pnpm check` を実行する。
- [ ] T-007: subagent による仕様適合レビューと品質・セキュリティレビューを行い、指摘を修正する。
- [ ] T-008: 利用者承認後に push、統合 PR 作成、旧 PR #4/#5 のクローズを行う。
