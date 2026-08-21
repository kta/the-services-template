# 本番デプロイ手順（runbook）

各サービスは **1 Worker が SPA と API を同一オリジンで配信**する。旧来の「SPA と API が別オリジン」に伴う CORS / `VITE_API_URL` の設定は存在しない。**Queue は一切使わない**（無料枠方針 — AGENTS.md ルール 9）。非同期通知は notifier の同期送信 API（`POST /api/internal/send`）に service binding で送る。

## 0. 前提
- Cloudflare アカウント / `CLOUDFLARE_API_TOKEN`（**Workers Scripts / D1 / KV / R2 Edit + Account Read**。Queues は不要）/ `CLOUDFLARE_ACCOUNT_ID`

## 1. 基盤を作る（Terraform）
```sh
cd infra/terraform/cloudflare
export CLOUDFLARE_API_TOKEN=...
cp terraform.tfvars.example terraform.tfvars   # account id
terraform init && terraform apply
terraform output            # D1 id / KV id / R2 bucket 名を控える
```

## 2. wrangler.jsonc に id を反映
- `services/admin/wrangler.jsonc` / `services/example_service/wrangler.jsonc`（→ フォーク後は自ドメインサービス）の `d1_databases[0].database_id` を TF 出力の値に。
- KV: `services/admin`（`AUTH_RL`）/ `services/notifier`（`DEDUPE`）の `kv_namespaces[].id` を TF 出力の値に。
- ops: `services/ops/wrangler.jsonc` の `ADMIN_DB_ID` を TF 出力の admin `database_id` に（バックアップ export 対象。自ドメインサービスを足したらその D1 も追加）。R2 バケットは TF が作成（`backups_r2_bucket_name` 出力）。

## 3. secrets を設定
**機密値は wrangler.jsonc の `vars` に置いていない**（公式方針: 機密は secrets のみ）。ローカル開発は各サービスの `.dev.vars`（`make init` が `.dev.vars.example` からコピー、gitignore 対象）、本番は `wrangler secret put` **のみ**。secret を設定するまで各サービスは fail close（internal API 401 / 認証不可）で動く。

`INTERNAL_KEY` は **service binding でつながる全サービスで同一値**。`JWT_SECRET` は発行側（admin）と検証側（**各ドメインサービスにも必ず設定**）で同一値。`AUTH_PEPPER` は **admin のみ**（パスワードハッシュは admin だけが扱う — ドメインサービスには設定不要）。
```sh
KEY="<high-entropy>"; JWT="<high-entropy>"; PEPPER="<high-entropy>"
for s in admin notifier ops; do   # 自ドメインサービスもここに足す
  echo -n "$KEY" | pnpm --filter @app/$s exec wrangler secret put INTERNAL_KEY
done
for s in admin; do                # 自ドメインサービスもここに足す（検証側にも JWT_SECRET が必要）
  echo -n "$JWT" | pnpm --filter @app/$s exec wrangler secret put JWT_SECRET
done
echo -n "$PEPPER" | pnpm --filter @app/admin exec wrangler secret put AUTH_PEPPER
# 通知メール。**未設定の本番は送信が fail close（502）** — LogSender は dev 専用
# （.dev.vars の MAIL_DEV_LOG=true でのみ有効。本番に MAIL_DEV_LOG を設定しない）
echo -n "<resend-key>" | pnpm --filter @app/notifier exec wrangler secret put RESEND_API_KEY
# 送信元アドレスは secret ではなく notifier/wrangler.jsonc の vars.MAIL_FROM を編集する
# （Resend は from ドメインの検証必須 → **検証済み運用ドメイン**。空のままだと既定の
# notifications@example.com にフォールバックし Resend に拒否される）
# ops バックアップ: D1 REST export トークン（**D1:Read のみ**にスコープ。容量監視も
# 同トークンで「Get database」→ file_size を読む）
echo -n "<d1-read-token>" | pnpm --filter @app/ops exec wrangler secret put D1_EXPORT_API_TOKEN
# 非機密の設定は wrangler.jsonc の vars で: ops の CF_ACCOUNT_ID（アカウント ID）と
# OPS_ALERT_EMAIL（アラート宛先 — **検証済み実メール**。未設定だと通知はスキップされる）、
# admin の OPS_ALERT_EMAIL（日次照合ドリフト通知の宛先）
# AUTH_DEV_GRANT は本番では**設定しない**（未設定 = fail close で dev グラント無効。
# dev では .dev.vars の AUTH_DEV_GRANT=true が有効化する）
```

## 4. リモート D1 マイグレーション → デプロイ
デプロイ順は **binding の参照先を先に**する: `notifier → admin → （自ドメインサービス） → ops`。相互 service binding のペアは、初回だけ先にデプロイした側が未作成の相手を参照する（wrangler はそのままデプロイし、両方揃えば解決）。ops は notifier/admin（+ドメインサービス）を binding するため最後。

> **フォーク時の必須作業**: `example_service` は雛形で**本番には決してデプロイされない**
> （CI の deploy matrix 対象外）ため、admin の `EXAMPLE_SERVICE` service binding は
> 本番では**恒久的に宙に浮く**。雛形を自ドメインサービスへ差し替える際、admin の
> `wrangler.jsonc` の binding 先（と `src/worker/sync.ts`）を新サービスへ張り替えて
> からデプロイすること。放置すると org 同期・日次照合が毎回失敗し続ける。
```sh
# deploy は pnpm の予約語なので必ず `run` を付ける。
# SPA サービスの `deploy` = vite build && wrangler deploy（ビルド出力の wrangler.json を自動使用）。
# notifier / ops の `deploy` は wrangler deploy のみ。
pnpm --filter @app/notifier run deploy
pnpm --filter @app/admin run db:migrate:remote && pnpm --filter @app/admin run deploy
pnpm --filter @app/ops run deploy
```
`example_service` はテンプレの雛形（`new-service` のコピー元）であり、**本番にはデプロイしない**（CI の deploy matrix からも除外。デプロイ資源を消費せず、雛形が攻撃面になることもない）。検証/e2e のみ対象。フォークして作った自ドメインサービスを matrix に足すこと。admin の EXAMPLE_SERVICE binding も、フォーク時に実サービスへ差し替える。
CI（`.github/workflows/ci.yml` の `deploy` job）は main push 時に上記 migrate→deploy を matrix（`max-parallel: 1` で直列・上記順）で実行する。Cron（admin の日次照合 / ops のバックアップ・監視）は各 `wrangler.jsonc` の `triggers.crons` から deploy 時に構成される。

## ⚠️ 本番前に必ず潰すこと（テンプレの意図的な dev 設定）
- **`AUTH_DEV_GRANT` を本番 secrets/vars に入れない**（未設定 = dev グラント 404 fail close。`true` を入れると任意 org の JWT 発行 = 認証バイパスが開く）。実運用は `/api/auth/login` を使う。
- `INTERNAL_KEY` / `JWT_SECRET` / `AUTH_PEPPER` は高エントロピー値を `wrangler secret put` で設定（`.dev.vars` の dev 値はローカル専用でデプロイに載らない）。**`INTERNAL_KEY` は全サービス同一**なのでローテーションは全サービス同時に。
- ops の `D1_EXPORT_API_TOKEN` は **D1:Read のみ**にスコープ（バックアップ export 専用・最小権限）。R2 バックアップバケットは非公開のまま運用する。**初回デプロイ後にリストア訓練を 1 回実施**（`docs/howto/restore.md`）。
- D1 / バックアップ R2 を消されたくない環境では Terraform の該当リソースに `lifecycle { prevent_destroy = true }` を足す。
