# インフラ仕様: infra

実装は `infra/terraform/cloudflare`、各 `wrangler.jsonc`、`.github/workflows/ci.yml`。詳細は `docs/architecture/infra.md` / `docs/howto/deploy.md`。

## 所有分担（1リソース=1オーナー）
- **Terraform**: D1（サービスごと）/ KV / R2 / DNS。**Queues は使わない**（設計判断 — `docs/howto/notifications.md`）。state は R2（ロック無し→CI直列）。
- **Wrangler**: 各 Worker のコード・バインディング・Cron・secrets。

## 環境
- dev: `vite dev`（`@cloudflare/vite-plugin` — SPA は HMR、Worker は実 workerd、ローカル D1/KV/R2）。
- 本番: 1 サービス = 1 Worker が SPA と API を**同一オリジン**で配信（Workers static assets + `run_worker_first`）。リモート D1 マイグレーションと secrets の設定が必須（`docs/howto/deploy.md`）。

## CI/CD（`.github/workflows/ci.yml`）
- `verify`（lint/typecheck/test+coverage）/ `e2e`（Playwright）/ `deploy`（main push で migrate→deploy を matrix）。
- 本番前に必須: admin 認証、dev トークン置換、`INTERNAL_KEY`/`JWT_SECRET` のローテート。

## サービス追加時のインフラ
新サービスは `infra/terraform/cloudflare/main.tf` に D1 を1つ追加し、`outputs.tf` に id を出力 → `services/<service>/wrangler.jsonc` に反映。
