# 本番デプロイ手順（runbook）

各サービスは 1 Worker が SPA と API を同一オリジンで配信する。旧来の「SPA と API が別オリジン」に伴う CORS / VITE_API_URL の設定は存在しない。Queue は一切使わない（無料枠方針 — AGENTS.md ルール 9）。非同期通知は notifier の同期送信 API（POST /api/internal/send）に service binding で送る。

この runbook の Worker production deploy は、GitHub Actions の production environment で
保護された `main` への push が verify を通過した経路だけである。任意ブランチの
`workflow_dispatch`（bootstrap を除く）、ローカルの production deploy/remote migration entry point、dirty checkout、
`example_service` の直接 deploy は本番 deploy 経路ではない。

既存 Worker への secret 登録、remote seed、restore は Worker code の deploy とは別の
operator 状態変更である。これらもローカル端末からは実行せず、protected `main` の
production workflow と required reviewer を通す。
初回 Worker 作成を伴う secret bootstrap は、専用の
`.github/workflows/production-bootstrap.yml` の `workflow_dispatch` だけで行う。
この workflow も protected `main`、`production` environment の required reviewer、
入力値の検証、対象 Worker ごとの secret allowlist を満たさない限り進まない。

## 0. 前提

- Cloudflare アカウント
- CLOUDFLARE_API_TOKEN（Workers Scripts / D1 / KV / R2 Edit + Account Read。Worker secret 名、D1/KV/R2
  resource identity、R2 public-domain 設定の事前検査を含む。Queues は不要）
- CLOUDFLARE_ACCOUNT_ID
- 本番 deploy を行うリポジトリの main が branch protection の対象であること
- GitHub の production environment に required reviewer と environment secrets が設定済みであること
- `production` environment に required reviewer、self-review 防止、selected branch `main` のみ、管理者 bypass 無効を設定すること。
  このテンプレートは deploy/bootstrap に GitHub OIDC (`id-token: write`) を要求しない

## 1. 基盤を作る（Terraform）

Terraform 1.10.5 以上（`mise install` で固定）を使う。ローカルでは
`make infra/check` の credentialless な format/init/validate のみを実行する。本番の
resource 作成・変更は、Terraform state を管理する組織の protected `main` /
required reviewer 付き infrastructure workflow から、reviewed plan artifact を承認して
実行する。Terraform state と `terraform.tfvars` はリポジトリへ commit しない。
`secret_text` を Terraform resource に書かず、Worker secret は protected bootstrap /
rotation workflow から登録する。

## 2. wrangler.jsonc に id を反映

- services/admin/wrangler.jsonc と、フォーク後の自ドメインサービスの d1_databases[0].database_id を TF 出力へ置き換える。
- KV: services/notifier（DEDUPE）の kv_namespaces[].id を TF 出力へ置き換える。admin の
  login lockout は admin D1 の原子的カウンタであり、KV binding は不要。
- services/ops/wrangler.jsonc の ADMIN_DB_ID と各バックアップ対象 D1 ID を設定する。
- R2 バケット名は TF output の値を ops の設定へ反映する。

反映後は、binding 型を生成する。

    pnpm -r --if-present cf-typegen

## 3. 本番 secrets を設定する

機密値を wrangler.jsonc の vars、Terraform state、GitHub repository のソースへ置かない。ローカル開発は各サービスの `.dev.vars`（`make init` が `.dev.vars.example` からコピー、gitignore 対象）だけを使う。本番の Worker secret は GitHub の `production` environment secrets として保管し、protected `main` の reviewer 済み workflow が、対象 Worker ごとの allowlist と 0600 の owner-only **topology-wide bundle** を検査してから反映する。`scripts/put-production-secret.mjs` はポリシー検査を再利用する validation-only CLI であり、ローカルから `wrangler secret put` や Worker write を実行しない。local D1 seed も本番用 credential を受け取らず、remote seed / restore を含む全ての本番状態変更は protected production workflow からだけ起動する。`--bootstrap` は Worker 作成を伴うため、専用の `production-bootstrap.yml`（protected `main` の workflow_dispatch、required reviewer）だけを使う。remote の secret API は名前しか返さないため、値の境界は provisioning 時にも守る。

### 3-1. 鍵の境界

| Secret | admin | domain Worker | notifier / ops | 用途 |
| --- | --- | --- | --- | --- |
| JWT_PRIVATE_KEY | 必須 | **設定しない** | 設定しない | access JWT の RS256 署名。admin だけが保持 |
| JWT_PUBLIC_KEY | 必須 | 必須 | 設定しない | access JWT の RS256 検証 |
| DOMAIN_TO_ADMIN_KEY | 必須 | 必須 | 設定しない | domain → admin の live-session introspection 用。admin の受信側と domain の送信側に同じ専用値を置くが、JWT 署名鍵や admin → domain 鍵とは分離する |
| ADMIN_TO_<DOMAIN>_KEY（雛形では `ADMIN_TO_EXAMPLE_SERVICE_KEY`） | 必須 | 必須 | 設定しない | admin → domain の組織同期用。fork 後は domain ごとに名前と値を分ける |
| ADMIN_TO_NOTIFIER_KEY | 必須 | 設定しない | 必須 | admin → notifier の通知用 |
| DOMAIN_TO_NOTIFIER_KEY | 設定しない | 必須 | 必須 | domain → notifier の通知用 |
| OPS_TO_NOTIFIER_KEY | 設定しない | 設定しない | ops / notifier に必須 | ops → notifier の通知用 |
| AUTH_PEPPER | 必須 | 設定しない | 設定しない | admin の password 検証 |
| AUTH_DEV_PRIVATE_KEY | **本番は設定しない** | **本番は設定しない** | 設定しない | admin/example のローカル dev grant 専用 |
| AUTH_DEV_GRANT | **本番は設定しない** | **本番は設定しない** | 設定しない | credential-less dev grant の明示スイッチ |

内部 API の鍵は方向ごとに別のランダム値を生成する。同じ値を複数の方向へ登録しない。`ADMIN_TO_<DOMAIN>_KEY` は domain ごとに名前と値を分け、domain A の侵害で domain B の service binding を呼べないようにする。`DOMAIN_TO_ADMIN_KEY` は domain → admin の live-session introspection だけに使う専用値で、両端に登録するが、JWT_PRIVATE_KEY、admin → domain、domain → notifier の鍵とは必ず分ける。admin 側の route は `x-internal-caller=domain` と Zod 契約でこの用途を限定し、domain の侵害で admin の JWT を偽造したり別方向の service binding を呼んだりできないことが境界の目的である。

JWT_PRIVATE_KEY は domain Worker、Tauri bundle、ブラウザ、ログ、CI artifact に渡さない。domain Worker は JWT_PUBLIC_KEY だけで検証する。issuer は `admin`、audience は admin API が `admin`、domain API が `domain:<service_name>`（雛形は `domain:example_service`）に固定され、別サービス向け token の replay を拒否する。JWT public key は environment secret から protected workflow の allowlist 済み bundle にだけ渡し、private key と同じ bundle を domain に渡さない。

domain の本番 token 発行元（IdP または admin gateway）はこのテンプレートの scope 外だが、domain の受信側 live-session 境界は `@app/shared` の `tenantAuth` → `requireLiveDomainSession` → `requireActiveOrg` として実装する。admin の login/refresh は `aud=admin` を発行し、domain は `aud=domain:<service_name>` だけを受け付けるため、admin token を domain token として受け入れてはいけない。`requireLiveDomainSession` は access JWT の `sid/sub/org` を admin の refresh session と現行 user/org に照合し、logout、refresh rotation、user/org 無効化を次の domain request から拒否する。admin binding の障害・タイムアウト・不正応答は 503 で fail close し、organization 同期の 2 時間 lease は可用性用コピーの鮮度であって認証の猶予ではない。コピーした domain を本番へ追加する前には、この gate を組み込んだ `services/<domain>/src/worker/production-auth.ts` と `test/production-auth.test.ts` も実装する。実装とテストがない domain は `require-production-domain-auth.mjs` が bootstrap、remote migration、deploy、secret provisioning の全てを fail close する。

### 3-2. RS256 key pair を生成して bootstrap 用 environment secret に登録する

初回 Worker 作成ではローカルから `put-production-secret.mjs --bootstrap` を実行しない。
`wrangler secret put` には Worker を作成する機能がなく、bootstrap は専用 workflow が
対象 Worker の reviewed config を checkout した状態で、allowlist 済みの `secrets.json`
を一時生成して deploy する。deploy 前に remote secret **名**を検査し、既存 Worker に
想定外の名前（特に domain の `JWT_PRIVATE_KEY`）があれば停止する。まだ存在しない
Worker だけは Cloudflare Workers Secrets API の HTTP 404（未作成）を初回作成として許容する。なお
`--secrets-file` は既存 secret を削除しないため、この検査に失敗した状態で強行してはならない。
このため、次の準備で生成した値は GitHub の `production`
environment secrets に登録し、workflow の reviewer gate を通して一度だけ使用する。

次の例は秘密鍵・内部鍵・pepper を owner-only の一時ディレクトリに置く。実運用の key
pair は環境ごとに新規生成する。ファイルの内容や値をログ・チャット・リポジトリへ出さない。

    set -euo pipefail
    umask 077
    key_dir="$(mktemp -d)"
    trap 'rm -rf "$key_dir"' EXIT

    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
      -out "$key_dir/JWT_PRIVATE_KEY"
    openssl pkey -in "$key_dir/JWT_PRIVATE_KEY" -pubout \
      -out "$key_dir/JWT_PUBLIC_KEY"
    # latest.json 用。JWT の pair や internal key と再利用しない。
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
      -out "$key_dir/BACKUP_SIGNING_PRIVATE_KEY"
    openssl pkey -in "$key_dir/BACKUP_SIGNING_PRIVATE_KEY" -pubout \
      -out "$key_dir/BACKUP_SIGNING_PUBLIC_KEY"
    openssl rand -hex 32 | tr -d '\n' > "$key_dir/DOMAIN_TO_ADMIN_KEY"
    # コピー済み domain の実名に合わせる(例: services/booking)。
    # 雛形の example_service は本番 deploy しないため、この例では使わない。
    domain_service='booking'
    openssl rand -hex 32 | tr -d '\n' > "$key_dir/ADMIN_TO_BOOKING_KEY"
    openssl rand -hex 32 | tr -d '\n' > "$key_dir/ADMIN_TO_NOTIFIER_KEY"
    openssl rand -hex 32 | tr -d '\n' > "$key_dir/DOMAIN_TO_NOTIFIER_KEY"
    openssl rand -hex 32 | tr -d '\n' > "$key_dir/OPS_TO_NOTIFIER_KEY"
    openssl rand -hex 32 | tr -d '\n' > "$key_dir/AUTH_PEPPER"

    # ADMIN_TO_BOOKING_KEY と ADMIN_TO_INVENTORY_KEY は別の値にする。
    # domain 名を変えたら、ファイル名・admin/domain の wrangler.jsonc・Worker source
    # の binding/secret 名を同じ suffix に変更する。

    # ここから先は GitHub の Settings → Environments → production →
    # Environment secrets へ、値を表示せず file から登録する例。
    # production environment には required reviewer を必ず設定する。
    gh secret set PRODUCTION_JWT_PRIVATE_KEY --env production < "$key_dir/JWT_PRIVATE_KEY"
    gh secret set PRODUCTION_JWT_PUBLIC_KEY --env production < "$key_dir/JWT_PUBLIC_KEY"
    gh secret set PRODUCTION_DOMAIN_TO_ADMIN_KEY --env production < "$key_dir/DOMAIN_TO_ADMIN_KEY"
    gh secret set PRODUCTION_ADMIN_TO_DOMAIN_KEY --env production < "$key_dir/ADMIN_TO_BOOKING_KEY"
    gh secret set PRODUCTION_ADMIN_TO_NOTIFIER_KEY --env production < "$key_dir/ADMIN_TO_NOTIFIER_KEY"
    gh secret set PRODUCTION_DOMAIN_TO_NOTIFIER_KEY --env production < "$key_dir/DOMAIN_TO_NOTIFIER_KEY"
    gh secret set PRODUCTION_OPS_TO_NOTIFIER_KEY --env production < "$key_dir/OPS_TO_NOTIFIER_KEY"
    gh secret set PRODUCTION_AUTH_PEPPER --env production < "$key_dir/AUTH_PEPPER"
    gh secret set PRODUCTION_BACKUP_SIGNING_PRIVATE_KEY --env production < "$key_dir/BACKUP_SIGNING_PRIVATE_KEY"

    # public half は secret ではない。review 済み ops/wrangler.jsonc の
    # vars.BACKUP_SIGNING_PUBLIC_KEY に PEM として反映する。

`CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` も `production` environment secret に
登録する。外部 API key は 3-3 の手順で同じ environment に登録する。bootstrap workflow が
参照する名前は次のとおりである。

| Workflow secret | 用途 | 対象 Worker |
| --- | --- | --- |
| `PRODUCTION_JWT_PRIVATE_KEY` / `PRODUCTION_JWT_PUBLIC_KEY` | RS256 key pair | admin / admin と domain |
| `PRODUCTION_DOMAIN_TO_ADMIN_KEY` | domain → admin live-session introspection | admin / 入力した domain |
| `PRODUCTION_ADMIN_TO_DOMAIN_KEY` | admin → 入力した domain の鍵 | admin / 入力した domain |
| `PRODUCTION_ADMIN_TO_NOTIFIER_KEY` | admin → notifier | admin / notifier |
| `PRODUCTION_DOMAIN_TO_NOTIFIER_KEY` | domain → notifier | domain / notifier |
| `PRODUCTION_OPS_TO_NOTIFIER_KEY` | ops → notifier | ops / notifier |
| `PRODUCTION_AUTH_PEPPER` | password 検証 | admin |
| `PRODUCTION_RESEND_API_KEY` | メール送信 | notifier |
| `PRODUCTION_D1_EXPORT_API_TOKEN` | D1 export / 容量確認 | ops |
| `PRODUCTION_R2_POLICY_CHECK_API_TOKEN` | R2 managed/custom domain の公開設定確認 | deploy/bootstrap/ops |
| `PRODUCTION_BACKUP_SIGNING_PRIVATE_KEY` | latest.json の署名 | ops |
| `PRODUCTION_NOTIFIER_DEDUPE_ID` | reviewed notifier DEDUPE KV namespace ID | CI の resource identity 検査 |
| `PRODUCTION_BACKUP_BUCKET_NAME` | reviewed ops BACKUPS R2 bucket name | CI の resource identity 検査 |
| `PRODUCTION_RESOURCE_MANIFEST` | protected environment 外で管理する resource ID/name 一覧 | config と本番 resource の drift 検査 |

`.github/workflows/production-bootstrap.yml` を protected `main` の Actions 画面から
`Run workflow` で起動し、`domain_service` には fork 後に実在するサービスディレクトリ
（例: `booking`）を入力する。workflow は `admin`、入力した domain、`notifier`、`ops`
の順に対象の allowlist だけを deploy する。`example_service`、予約済み Worker 名、
不正なサービス名は拒否される。environment の required reviewer が承認しない限り
Cloudflare credential は利用可能にならない。

bootstrap workflow は Worker ごとに固定した allowlist の JSON bundle を shell で生成し、lockfile
から offline で検証した Wrangler の固定コマンドで `--no-bundle --secrets-file` のみを実行する。Cloudflare credential が
有効になった後にリポジトリの provisioning JavaScript、`pnpm run deploy`、remote migration の
package lifecycle hook は実行しない。したがって workflow の environment secrets と、ops の
`vars.BACKUP_SIGNING_PUBLIC_KEY` を含む reviewed config を先に全て揃える。ops の private
signer は `BACKUP_SIGNING_PRIVATE_KEY`、公開側は `BACKUP_SIGNING_PUBLIC_KEY` であり、JWT pair
や internal key と同じ値を使わない。

既存 Worker の鍵ローテーションも、ローカルの `put-production-secret.mjs` や raw Wrangler
では行わない。新しい topology-wide bundle を environment secrets に登録し、
`production-bootstrap.yml` を protected `main` から reviewer 承認付きで再実行する。
workflow は remote secret **names**、全方向鍵の重複、JWT pair、backup signer pair、対象
Worker ごとの allowlist を write 前に検査する。secret API は値を返さず、複数 Worker の更新は
原子的ではないため、rotation は maintenance window と rollback bundle を承認してから行う。

### 3-3. 内部鍵・pepper・外部 API key

RESEND_API_KEY、D1_EXPORT_API_TOKEN、R2_POLICY_CHECK_API_TOKEN、内部鍵は、3-2 と同じ
owner-only 作業ディレクトリから GitHub `production` environment secret へ登録する。
Worker への反映は `production-bootstrap.yml` の reviewer 済み fixed bundle だけが行う。
このリポジトリの `put-production-secret.mjs` CLI は validation-only で、ローカルの
`wrangler secret put` や Worker write を実行しない。

RESEND_API_KEY は notifier の送信専用、D1_EXPORT_API_TOKEN は ops の D1 export / 容量確認、R2_POLICY_CHECK_API_TOKEN は R2 の managed/custom domain 設定確認だけに必要な最小権限へ絞る。3 つを同じ token にしない。送信元は services/notifier/wrangler.jsonc の vars.MAIL_FROM に検証済みドメインのアドレスを設定する（secret の値を vars に移さない）。production-config preflight は placeholder の D1/KV/R2、scaffold binding、空の MAIL_FROM、非 production APP_ENV を検出して deploy を停止する。

AUTH_DEV_GRANT と AUTH_DEV_PRIVATE_KEY は本番に登録しない。どちらか一方でも欠ければ /api/auth/token は 404 で fail close する。ローカルの AUTH_DEV_PRIVATE_KEY は公開リポジトリの test/dev fixture と同じ用途であり、本番鍵ではない。

### 3-4. R2 バックアップバケットを非公開にする

`wrangler.jsonc` の `BACKUPS` binding は、r2.dev の managed domain や custom domain の
公開設定を自動では無効化しない。本番 deploy/bootstrap の前に
`scripts/check-r2-private.mjs` が Cloudflare API で両方を検査する。managed domain は
disabled、custom domain は登録済みの全 domain が disabled でなければ fail close する。
API エラーや設定を取得できない状態も成功扱いにしない。

    node scripts/check-r2-private.mjs

この検査は `services/ops/wrangler.jsonc` の account ID と bucket 名を正典として使い、
`CLOUDFLARE_ACCOUNT_ID` が設定されている場合は config と完全一致することも確認する。CI は
credential を渡す前に `scripts/production-resource-identities.mjs` で `BACKUPS` の bucket 名と
runtime var、ops の `*_DB_ID` と各 service の D1 UUID/name を照合する。credential 取得後は
Cloudflare API の account/D1 resource を同じ ID/name で再照合してから Wrangler を起動する。
Worker runtime は R2 binding の bucket 名を返さないため、ops は deploy 時に reviewed config
へ固定された binding を使い、`latest.json` に account/bucket の非機密 metadata も記録する。
後続の freshness check はこの metadata が現在の reviewed runtime 値と一致しない manifest を
信頼しない。これで設定・control plane・data plane の不一致を fail close する。
バックアップバケットに公開 domain を追加する運用は、このテンプレートの機密バックアップ
境界外なので許可しない。

### 3-5. organization 無効化の伝播境界

organization の作成・変更・無効化は admin から domain へ service binding で同期する。同期に失敗した場合は admin の応答で `synced: false` を返し、hourly reconcile が再試行する。domain の `synced_at` lease は 2 時間で、無効化済みの行でも lease を超えると `503 not_synced` へ fail close する。この lease はコピーの鮮度を守る可用性境界であり、production API の認証猶予ではない。production domain は `requireLiveDomainSession` で admin の refresh session、user、org を毎リクエスト照合するため、logout、refresh rotation/reuse revoke、user/org 無効化は次の request から 401 になる。admin の introspection binding が停止・timeout・不正応答になった場合も 503 `auth_unavailable` で fail close する。

## 4. GitHub production environment を保護する

リポジトリの Settings → Environments → production を開き、次を設定する。

1. Deployment branches and tags を **selected branch `main` のみ**にする。GitHub API 上は `protected_branches=false`、`custom_branch_policies=true`、deployment branch policy が `type=branch` / `name=main` の 1 件だけになる設定である。protected branches only は main 以外の protected branch も許可し得るため使わない。workflow 側でも `refs/heads/main` を固定し、main の branch protection と組み合わせて二重に限定する。
2. Required reviewers に本番変更を承認できる担当者を設定し、自己承認を許可しない
   (`prevent_self_review=true`)。
3. Environment secrets として CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID を登録する。
4. repository secrets に同名の Cloudflare credential を重複登録しない。workflow は production environment の secrets.* だけを参照する。
5. main の branch protection を有効にし、Actions の deploy job が github.ref_protected == true を満たす状態にする。

`.github/workflows/ci.yml` の verify は main push で `github.ref_protected` が false の場合も失敗する。
そのため、branch protection が未設定のリポジトリでは deploy が黙って skip されず、設定不備として止まる。
deploy job 自体は push + refs/heads/main + protected ref の三条件が必要で、workflow_dispatch では起動しない。
manual e2e と Tauri artifact workflow は Cloudflare credential を持たず、検証だけを行う。
deploy/bootstrap は Cloudflare credential を使う直前に GitHub REST API でも production environment と deployment branch policy を検査し、selected `main` 以外の許可、protected-branches-only、required reviewer、self-review 防止のいずれかが欠けていれば fail close する（`scripts/check-github-production-environment.mjs`）。
deploy/bootstrap は GitHub OIDC token に依存しない。代わりに、workflow の実行条件を
protected `main` の push または `workflow_dispatch` に固定し、production environment の
selected branch・required reviewer・管理者 bypass 無効を GitHub REST API で credential 使用直前に
検査する。さらに checkout の実 SHA、fresh に取得した canonical `origin/main`、exact-SHA verify
結果、artifact manifest の repository/SHA/workflow/run provenance、各 output の SHA-256 を照合する。
環境変数を手動で偽装したローカル実行や、別 branch・別 commit の artifact は production 境界を満たさない。

## 5. リモート D1 マイグレーション → デプロイ

デプロイ順は binding の参照先を先にする。テンプレート自身は
`notifier → admin → ops`、fork して domain Worker を追加した場合は
`notifier → admin → 自ドメインサービス → ops` の単一チェーンにする。相互 service
binding の pair は初回だけ一方が未作成でも Wrangler が deploy できるが、両 Worker が揃う
まで同期処理は成功しない。

ローカルの Make/package には production deploy と remote migration の entry point を公開していない。
残る wrapper を直接呼んでも、`require-production-deploy.mjs` が CI の protected-main push 以外を
拒否する。したがって、次の確認は CI が想定する checkout 条件を手元で確認するための
チェックリストであり、ローカルから production Cloudflare CLI を起動する手順ではない。

次の確認は CI が使う checkout 条件を手元で確認するためのチェックリストであり、ローカルから
production Cloudflare CLI を起動する手順ではない。

    git config --get remote.origin.url
    git fetch --no-tags --prune origin refs/heads/main:refs/remotes/origin/main
    git status --short                 # 空であること
    git branch --show-current          # main であること
    test "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)"
    pnpm run test:deploy-boundary

protected `main` への push が verify を通過したときだけ、CI が次の単一チェーンを
実行する。

    notifier build → deploy
    admin build → remote migration → deploy
    ops build → deploy

フォーク後に domain を追加した場合だけ、admin と ops の間へ次を明示的に挿入する。

    copied domain build → remote migration → deploy

本番 deploy と remote migration の Make/package entry point は意図的に削除している。
credentialed Wrangler は、credentialless artifact を先に作成し、environment reviewer、
resource identity、config、remote secret-name、R2 privacy を確認した CI workflow の
固定コマンドだけが実行する。`scripts/production-deploy.mjs` と
`scripts/production-migrate.mjs` は guard のテスト対象として残るが、CI 外では
`require-production-deploy.mjs` が拒否する。既存 Worker の secret 登録、remote seed、restore
も protected `main` の production workflow と required reviewer を通す。`put-production-secret.mjs`
は validation-only であり、remote seed / restore wrapper は workflow の guarded step としてだけ
実行する。フォーク後は CI の ordered chain、admin binding、ops
backup/health target、domain の production-auth を同じ PR で追加し、
`check-deploy-boundary.mjs` を green にする。直接 raw Wrangler を呼ぶ経路は本番 runbook に
追加しない。Cron（admin の hourly 照合 / ops の backup・監視）は各 `wrangler.jsonc` の
`triggers.crons` から deploy 時に構成される。

## 6. Tauri の開発・artifact と本番 deploy の分離

ブラウザ版は `make dev/admin` / `make dev/example_service`、Tauri desktop 開発は
`make dev/admin/tauri` / `make dev/example_tauri_service/tauri`、静的 bundle の確認は
`make build/admin/tauri` / `make build/example_tauri_service/tauri` を使う。Tauri artifact
workflow は protected `main` からの `workflow_dispatch` 専用で、unsigned/debug artifact
を保存するだけである。Tauri の build 成果物に Cloudflare API token、Worker secret、
JWT_PRIVATE_KEY を入れない。`make build/<service>/tauri` は Cloudflare deploy を行わず
`services/<service>/dist/tauri` だけを生成し、`make dev/<service>/tauri` は Worker/Vite
dev server と native window をまとめて起動する。

Tauri の詳細（TAURI_DEV_HOST、mobile の port forwarding、fixed API origin、native bridge の allowlist）は tauri-example-service.md と architecture/tauri-native-app.md を参照する。

## 7. 本番前チェックリスト

- AUTH_DEV_GRANT / AUTH_DEV_PRIVATE_KEY が admin/domain の本番 Worker に存在しない。
- admin に JWT_PRIVATE_KEY と対応する JWT_PUBLIC_KEY がある。
- domain Worker に JWT_PUBLIC_KEY はあるが JWT_PRIVATE_KEY はない。
- service binding の内部鍵は方向ごとに別値で、admin → domain、admin → notifier、domain → notifier、ops → notifier の対応する両端だけに登録されている。
- AUTH_PEPPER は admin だけにある。
- Worker secret は GitHub `production` environment secret から protected workflow の allowlist 経由で登録され、vars / Terraform state / source / Tauri artifact にない。`put-production-secret.mjs` は validation-only で、topology-wide bundle 検査により JWT pair 不一致、既知の dev/test 値、全方向鍵重複がないことを確認する。ops の R2 policy token と `BACKUP_SIGNING_PRIVATE_KEY` も allowlist・scope 分離を満たす。
- main が protected branch であり、production environment が selected branch `main` のみ（`custom_branch_policies` の 1 policy）/ required reviewer / self-review 防止 / secrets になっている。
- CI の deploy checkout が main、push の SHA と一致し、verify が成功している（ローカルの `git status` 確認だけでは deploy 許可にならない）。
- 本番対象の D1 migration が deploy 前に CI で成功している。
- notifier の RESEND_API_KEY、MAIL_FROM、ops の D1_EXPORT_API_TOKEN が実環境の値である。
- ops の `BACKUP_SIGNING_PRIVATE_KEY` と `vars.BACKUP_SIGNING_PUBLIC_KEY` が同じ専用 pair で、
  `latest.json` の署名検証が成功する。R2 の managed/custom public domain は全て disabled である。
- コピー済み domain は `production-auth.ts` と対応テストを持ち、
  `require-production-domain-auth.mjs` が成功している。domain が admin の `aud=admin`
  token を受け入れたり、logout/revoke 後も `sid` のない stateless token を長時間受け入れたりしない。
- 初回 deploy 後に restore.md のリストア訓練を 1 回実施する。

`example_service` と `example_tauri_service` はコピー元の雛形であり、本番対象ではない。フォーク後は自ドメインサービスを production deploy chain、remote migration、ops backup、admin の EXAMPLE_SERVICE binding へ明示的に追加し、`check-deploy-boundary.mjs` が green になってから protected `main` に merge する。
