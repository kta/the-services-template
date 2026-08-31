# インフラ仕様: infra

実装は `infra/terraform/cloudflare`、各 `wrangler.jsonc`、`.github/workflows/ci.yml`。詳細は `docs/architecture/infra.md` / `docs/howto/deploy.md`。

## 所有分担（1リソース=1オーナー）
- **Terraform**: D1（サービスごと）/ KV / R2。DNS・custom domain は外部の手動/別 IaC
  管理とし、この template では所有しない。**Queues は使わない**（設計判断 —
  `docs/howto/notifications.md`）。state は R2（Terraform `use_lockfile` + CI single-writer）。
- **Wrangler**: 各 Worker のコード・バインディング・Cron・secrets。

## 環境
- dev: `vite dev`（`@cloudflare/vite-plugin` — SPA は HMR、Worker は実 workerd、ローカル D1/KV/R2）。
- 本番: 1 サービス = 1 Worker が SPA と API を**同一オリジン**で配信（Workers static assets + `run_worker_first`）。リモート D1 マイグレーションと secrets の設定が必須（`docs/howto/deploy.md`）。

## CI/CD（`.github/workflows/ci.yml`）
- `verify`（lint/typecheck/test+coverage）/ `e2e`（Playwright）/ `deploy`（protected main push で notifier→admin migration→admin→copied domain migration→copied domain→ops を順序実行）/ `production-bootstrap`（初回 Worker の protected-main workflow_dispatch）。copied domain は、人間承認済み issuer/gateway から正規の `aud=domain:<service>` + live `sid` token を取得し、成功・wrong audience・`sid` 欠落・logout/rotation・user/org 無効化・admin failure 503 を fixture で実行できるまで readiness false とする。negative-only fixture は production chain の証明にならない。
- 本番前に必須: admin 認証、dev トークン無効化、caller-specific 内部鍵の方向別ローテーション、admin 専用 `JWT_PRIVATE_KEY` と各 Worker の `JWT_PUBLIC_KEY` の配布確認。
- production deploy は保護された `main` の push かつ GitHub `production` environment の selected `main` policy、reviewer/self-review 防止を満たす場合だけ許可する。任意ブランチの `workflow_dispatch` は verify/e2e と unsigned artifact の検証に限定する。初回 Worker 作成を伴う secret bootstrap は専用 workflow の protected-main `workflow_dispatch` と `production` environment reviewer に限定する。現行 catalog の deployable domain は 0 件であり、bootstrap bundle は最大 1 domain だけを検査する。2 件以上は fail close し、全 domain key を一括検証する人間承認済み設計までは multi-domain を許可しない。
- native artifact の protected-main manual workflow は credential/signing を受け取らず、reviewed placeholder HTTPS origin による desktop `cargo check --locked --release` で build.rs の release-only env 境界を検証する。追加 compile cost は通常 PR verify に含めない。

## サービス追加時のインフラ
新サービスは `infra/terraform/cloudflare/main.tf` に D1 を1つ追加し、`outputs.tf` に id を出力 → `services/<service>/wrangler.jsonc` に反映。
