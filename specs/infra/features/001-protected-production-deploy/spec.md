- ステータス: Approved

# 001-protected-production-deploy: 本番デプロイ境界

## 1. WHAT / WHY

**概要**（3 行以内）:

本番の Cloudflare deploy を保護された `main` の push に限定し、手動 workflow の任意ブランチ実行が本番資格情報へ到達しないようにする。初回 Worker 作成を伴う secret bootstrap は専用 workflow の protected-main `workflow_dispatch` と production environment reviewer に限定し、ローカルの deploy/remote migration/package entry point からは到達できないようにする。production environment は selected `main` の 1 branch policy とし、その設定を runbook に明記する。

**ユーザーストーリー**:

- US-INFRA-01: リポジトリ管理者として、任意ブランチの workflow dispatch やローカル checkout から本番 Worker を上書きされないようにしたい。

**検証項目**:

- INFRA-INFRA-01: Given `.github/workflows/ci.yml` を任意ブランチから `workflow_dispatch` する When workflow が開始する Then verify/e2e は実行できても production deploy job は実行されない。
- INFRA-INFRA-02: Given `ci.yml` の production deploy When event/ref/protection 条件を確認する Then `push`、`refs/heads/main`、保護ブランチの条件をすべて満たさない限り job が開始しない。
- INFRA-INFRA-03: Given production deploy job When Cloudflare credentials を参照する Then credentials は `production` environment の secrets からのみ供給され、manual Tauri artifact workflow には供給されない。
- INFRA-INFRA-04: Given ローカル checkout から production deploy / remote migration の Make・package entry point または `production-deploy.mjs` / `production-migrate.mjs` を実行する Then Make・package entry point は存在せず、wrapper も Cloudflare CLI を起動せず CI 外として失敗する。
- INFRA-INFRA-05: Given deploy runbook When production environment を設定する Then selected branch `main` の 1 policy のみを許可し、required reviewer/self-review 防止と environment secret の登録手順が明記されている。
- INFRA-INFRA-06: Given production の service-binding secret を設定する When domain Worker が侵害される Then domain → admin / admin → notifier / ops → notifier の別方向鍵を利用できず、caller-specific な内部 API 境界を越えられない。
- INFRA-INFRA-07: Given `main` への push When GitHub が ref を protected と報告しない Then verify は成功扱いにせず、production deploy を開始しない。
- INFRA-INFRA-08: Given 初回 Worker の secret bootstrap When workflow を起動する Then `workflow_dispatch`、`refs/heads/main`、protected ref、production environment reviewer、入力検証、対象 Worker ごとの allowlist をすべて満たさない限り Cloudflare CLI を起動せず、domain Worker へ `JWT_PRIVATE_KEY` を渡さない。

**スコープ外**:

- Cloudflare 側の dashboard/API token 発行そのもの、Terraform resource の作成・削除。
- staging 環境や preview deploy の新設。
- 本番 deploy の実行、Cloudflare への外部送信。

**不明点**: なし（GitHub environment の selected-main policy / branch protection / required reviewer は repository settings で設定する）。

## 2. HOW

**触るファイル**:

- `.github/workflows/ci.yml` — deploy job の event/ref/protected 条件と production environment secrets。
- `.github/workflows/production-bootstrap.yml` — 初回 Worker secret bootstrap の protected-main workflow と environment secrets。
- `Makefile` — production deploy / remote migration target を公開せず、credentialless build・check・Tauri 開発だけを提供する。
- `scripts/check-deploy-boundary.mjs` / `scripts/require-production-bootstrap.mjs` / `package.json` — workflow と Make guard の回帰検査。
- `docs/howto/deploy.md` / `docs/howto/cloudflare-setup.md` — environment 設定、secret 名、main 限定の runbook。
- `specs/infra/00_infra-spec.md` / `docs/architecture/infra.md` — CI/CD の正典。
- `packages/shared/src/internal.ts` と各 Worker の binding — caller-specific な内部 API 鍵の照合境界。

**データモデル差分**: なし。

**却下した代替案**:

- `workflow_dispatch` を削除するだけの案 — 手動 e2e/artifact 検証まで失い、deploy と検証の境界を説明できない。
- repository secret のまま運用する案 — environment protection が資格情報の読み出しを防ぐ境界にならない。
- Make target の確認だけに頼る案 — GitHub Actions や直接 wrapper/package の経路を制限できない。

## 3. TASKS

- [x] T-001: workflow 条件・environment secret・Make guard の静的回帰テストを追加する。
- [x] T-002: `ci.yml`、Makefile、package script を最小変更で保護境界へ更新する。
- [x] T-003: deploy/cloudflare 文書、AGENTS、README、CODEMAP の secret 名・実行条件を更新する。
- [x] T-004: deploy boundary test、workflow YAML 構文確認、`pnpm check` を実行し、検証項目を確認する。
- [x] T-005: 初回 Worker secret bootstrap を protected-main の専用 workflow に分離し、domain へ秘密鍵を渡さない allowlist と runbook を追加する。
