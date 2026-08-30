# インフラ方針（Terraform × Wrangler）

## 配信アーキテクチャ

- 1 サービス = 1 Worker が SPA と API を両方配信する（Workers static assets）。
- assets.not_found_handling は single-page-application、run_worker_first は /api/*。Pages は使わない。
- 開発は @cloudflare/vite-plugin の単一 dev server（SPA は Vite HMR、Worker は実 workerd）。proxy 設定・二重起動は存在しない。
- vite build が dist/client（assets）と dist/<worker>/wrangler.json（出力設定）を生成し、Wrangler deploy がそれを使う。

## 分担（1 リソース = 1 オーナー）

- Terraform が所有: D1 / KV / R2。DNS・カスタムドメイン・ルーティングはこの
  template の Terraform 管理対象外なので、Cloudflare Dashboard/API 等で別途管理し、
  Worker 名と custom domain の対応を deploy 前に確認する。Queues は使わない。
  TF outputs の ID を各 wrangler.jsonc に反映する。
- Wrangler が所有: Worker code、binding、Cron、Workflow、Worker secret。
- 同一リソースを Terraform と Wrangler の両方で管理しない。
- secret の値を Terraform state、wrangler.jsonc の vars、ソース、Tauri artifact に置かない。

R2 の backup bucket は private-only で運用する。R2 binding の宣言だけでは r2.dev の
managed domain / custom domain の public access を閉じないため、deploy/bootstrap の
credential 使用前に `scripts/check-r2-private.mjs` が Cloudflare API の両方の設定を確認する。
managed domain の `enabled` は false、custom domain の全 `enabled` も false が必須で、API
エラーは fail close とする。Terraform の R2 resource だけを見て公開状態を推測しない。
同じ境界で `scripts/production-resource-identities.mjs` が reviewed config の ops account、
`BACKUPS` bucket 名、ops が参照する各 D1 の UUID/name を照合し、credential 取得後にも
Cloudflare API の account/D1 resource identity を直接再確認する。backup の `latest.json` は
account/bucket metadata を持ち、ops runtime は reviewed identity と異なる manifest を
freshness の正典として扱わない。設定ファイルだけ、または API の名前だけを信頼して別
resource へバックアップ/監視する経路を作らない。

## 認証 secret の境界

access JWT は RS256 固定である。admin が JWT_PRIVATE_KEY で署名し、admin と domain Worker は JWT_PUBLIC_KEY で検証する。issuer は `admin`、audience は admin API が `admin`、domain API が `domain:<service_name>`（雛形は `domain:example_service`）でサービスごとに固定し、別用途の署名済み token を受け付けない。domain Worker、Tauri、ブラウザには private key を配布しない。AUTH_PEPPER は admin のみ、内部 API 鍵は caller と受信先の方向ごとに分離する（admin → 各 domain は domain ごとに `ADMIN_TO_<DOMAIN>_KEY`、domain → admin live-session introspection は `DOMAIN_TO_ADMIN_KEY`、admin → notifier、domain → notifier、ops → notifier）。domain A 用の鍵を domain B や別方向へ再利用しない。AUTH_DEV_GRANT / AUTH_DEV_PRIVATE_KEY はローカル専用であり本番に設定しない。

production domain の API middleware は `tenantAuth` の署名・audience 検証だけで認証を完了させない。`requireLiveDomainSession` が `sid/sub/org` を admin の refresh session と現行 user/org に service binding で照合し、logout、rotation/reuse revoke、user/org 無効化を次の request へ反映する。admin binding の障害や不正応答は 503 fail close とし、organization 同期 lease は認証の猶予ではない。

ops の `latest.json` は JWT 用とは別の RSA signing pair で署名する。private half は
`BACKUP_SIGNING_PRIVATE_KEY` secret、public half は reviewed config の
`vars.BACKUP_SIGNING_PUBLIC_KEY` とし、production の freshness 判定と restore wrapper は
署名・algorithm・target/account/database provenance を全て検証する。D1 export の
Content-Length と実体ストリームには 512 MiB の上限を適用する。

詳細な登録手順とローテーションは [docs/howto/deploy.md](../howto/deploy.md) に集約する。

Cloudflare credential も用途ごとに分離する。GitHub Actions/Terraform の deploy token、ops
Worker の D1 REST export token、R2 世代からの restore operator token は別発行・別棚卸しとし、
`D1_EXPORT_API_TOKEN` に R2 読み書き権限を与えない。restore operator は reviewed な ops account
と復元対象 database の一致確認を通過した wrapper からだけ使う。

## 本番 deploy の境界

GitHub Actions の production deploy は verify 成功後、push event、refs/heads/main、protected ref の三条件を満たす場合だけ起動する。job は GitHub production environment を使用し、Cloudflare credential はその environment secrets からだけ供給する。environment の deployment branch policy は selected `main` の 1 件だけ（`protected_branches=false`、`custom_branch_policies=true`）とし、required reviewer/self-review 防止と main の branch protection はリポジトリ設定で有効化する。

workflow_dispatch は verify/e2e と unsigned Tauri artifact の検証に限定し、本番 Cloudflare credential を持たない（secret bootstrap/rotation、remote seed、restore の protected production workflow を除く）。Worker の production deploy / remote migration は protected `main` への push を起点とする GitHub Actions のみが実行し、ローカルの Make/package entry point は CI 外で fail close する。既存 Worker の secret 登録、remote seed、restore も protected `main` の production workflow と required reviewer を要求する。`example_service` と `example_tauri_service` は雛形であり production deploy chain と本番 target から除外する。
初回 Worker 作成を伴う secret bootstrap だけは例外的に専用の
`.github/workflows/production-bootstrap.yml` の `workflow_dispatch` を使うが、
protected `main`、production environment の required reviewer、入力検証、対象 Worker
ごとの allowlist をすべて満たす必要がある。bootstrap でも domain Worker へは
`JWT_PUBLIC_KEY` のみを渡し、`JWT_PRIVATE_KEY` は admin にだけ登録する。

デプロイチェーンはテンプレートでは `notifier → admin → ops`。fork で domain Worker を
追加したときだけ、admin と ops の間にその domain の remote migration/deploy を挿入する。
ただし domain は production-auth gateway/IdP、domain audience、`sid` の revoke 照合を
実装した `src/worker/production-auth.ts` と対応テストを追加し、`require-production-domain-auth.mjs`
を通過するまで chain/bootstrap/secret provisioning の対象にできない。admin の
`aud=admin` token を domain で受け入れる実装は境界を壊すため禁止する。

## State backend（R2）

backend "s3" を R2 endpoint（region = auto、skip_*、use_path_style、`use_lockfile = true`）で使う。Terraform の lockfile に加えて CI concurrency 等で apply を直列化する。

## 料金の前提（Workers Free）

- 静的 assets 配信は無料・無課金リクエスト。
- 通知は notifier への同期送信 API（KV 冪等 + 再検知 Cron）。
- Cron は Free でアカウント全体 5 トリガーまで（UTC）。サービスを増やすと共有枠を消費する。
- 上限と設計対処の全量は [docs/howto/free-tier-limits.md](../howto/free-tier-limits.md) に記載する。

## 非 Cloudflare（必要なら）

Auth0（認証）/ Resend（メール）/ GA4（解析）。AWS は使わない。
