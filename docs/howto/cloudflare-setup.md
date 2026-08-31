# Cloudflare 初期設定（手動手順）

ローカルで動かすだけなら Cloudflare アカウントは不要（make dev/*・test・e2e はすべてローカルの workerd で動く）。ここはインターネットに公開するときに一度だけ必要な作業である。

エージェントに任せる場合は README の「Cloudflare につなぐ」プロンプトを使う。この文書は「自分で手を動かす場合」と、エージェントが参照する手順書を兼ねる。人間にしかできないのは、アカウント作成、wrangler login の OAuth、API トークン発行、GitHub environment protection の最終承認である。

デプロイ手順の全量（secret の境界、main 限定、production environment、チェックリスト）は deploy.md が正である。

## 1. アカウントと Wrangler の認証

    set -euo pipefail
    # アカウント作成: https://dash.cloudflare.com/sign-up（Free プラン）
    pnpm --filter @app/admin exec wrangler login
    pnpm --filter @app/admin exec wrangler whoami

Wrangler は各サービスの devDependency なので個別インストール不要である。

## 2. CI 用 API トークン

ダッシュボード → My Profile → API Tokens → Create Token で発行する。これは GitHub Actions の
production deploy/bootstrap と Terraform 用の token であり、必要権限は Workers Scripts:Edit、D1:Edit、
Workers KV Storage:Edit、Workers R2 Storage:Edit、Account Settings:Read である。Queues 権限は不要である。

この token を restore 操作や ops Worker の D1 export に流用しない。D1 export は ops の
`D1_EXPORT_API_TOKEN`（対象 account の D1 REST export に必要な read-only scope）のみを使う。
R2 世代からの restore は別の operator token（R2 Object Read/List/Write/Delete と、明示的な
D1 create/execute/time-travel に必要な最小 scope）を使い、`docs/howto/restore.md` の
account ID 一致確認を通す。Write は Time Travel 前の退避、Delete は operator cleanup に
必要であり、対象 bucket のみに限定する。
deploy token、D1 export token、restore operator token は別 token として発行・棚卸しする。

GitHub Actions の Cloudflare credential は repository secret ではなく production environment secret に登録する。
production environment には次の 17 個を**全て**登録し、repository secret 側には同名を置かない。
`PRODUCTION_NOTIFIER_DEDUPE_ID` と `PRODUCTION_BACKUP_BUCKET_NAME` は機密値ではないが、review 済み
resource identity の source-of-truth として environment secret に固定する。さらに
`PRODUCTION_RESOURCE_MANIFEST` には account、bucket、dedupe、各 D1 の reviewed ID/name を
JSON で登録し、repository 側 config の書き換えだけで本番先を差し替えられないようにする。

    set -euo pipefail
    gh secret set CLOUDFLARE_API_TOKEN --env production
    gh secret set CLOUDFLARE_ACCOUNT_ID --env production --body "<wrangler whoami の Account ID>"
    gh secret set PRODUCTION_NOTIFIER_DEDUPE_ID --env production --body "<notifier DEDUPE KV namespace id>"
    gh secret set PRODUCTION_BACKUP_BUCKET_NAME --env production --body "<ops BACKUPS bucket name>"
    gh secret set PRODUCTION_RESOURCE_MANIFEST --env production < ./production-resource-manifest.json
    gh secret list --env production

API token をコマンド引数やリポジトリへ書かない。Account ID は非機密だが、運用を揃えるため environment secret として登録する。Settings → Environments → production で、Deployment branches and tags は **selected branch `main` のみ**（protected branches only ではない custom branch policy）、required reviewer、self-review 防止、environment secrets を必ず設定する。`scripts/check-github-production-environment.mjs` が API で `main` 以外の許可や旧 protected-branches-only 設定を検出すると fail close する。

## 3. リソースを作る — 承認済み infrastructure workflow から実行

Terraform（D1 / KV / R2 の定義。適用は protected workflow のみ）:

Terraform は `mise.toml` で **1.10.5** に固定する（`mise install`）。
S3/R2 backend の `use_lockfile` を使うため、1.10 未満では実行しない。

ローカルでは `make infra/check` または次の credentialless 検査だけを実行する。

    terraform -chdir=infra/terraform/cloudflare fmt -check -diff
    terraform -chdir=infra/terraform/cloudflare init -backend=false -input=false
    terraform -chdir=infra/terraform/cloudflare validate

本番リソースの作成・変更は、組織の protected `main` / required reviewer 付き
infrastructure workflow で reviewed plan artifact を承認して行う。ローカルから
Terraform apply や Wrangler の resource create を実行しない。`terraform.tfvars` と state
はリポジトリへ commit せず、state は application backup と別の private R2 bucket に置く。

`example_service` は雛形のため、本番 Worker/D1 としては作成・deploy しない。自ドメインへ fork したら、そのサービス用 D1 を作成する。

## 4. ID を wrangler.jsonc に反映

services/<name>/wrangler.jsonc の placeholder を実値に置き換える。

| サービス | 項目 |
| --- | --- |
| admin | d1_databases[0].database_id |
| 自ドメインサービス | d1_databases[0].database_id |
| notifier | KV DEDUPE の id |
| ops | vars.CF_ACCOUNT_ID / バックアップ対象の *_DB_ID / R2 bucket |

反映後:

    set -euo pipefail
    pnpm -r --if-present cf-typegen

## 5. Worker secret の境界

本番の access JWT は RS256 で署名する。JWT_PRIVATE_KEY は admin にだけ登録し、domain Worker には JWT_PUBLIC_KEY だけを登録する。admin 自身も JWT_PUBLIC_KEY で検証する。issuer は `admin`、audience は admin API が `admin`、domain API が `domain:<service_name>`（雛形は `domain:example_service`）に固定される。以前の共有署名 secret を再利用しない。domain をコピーしたら service 名に対応する audience も一意にする。

| Secret | 登録先 |
| --- | --- |
| JWT_PRIVATE_KEY | admin のみ |
| JWT_PUBLIC_KEY | admin と各 domain Worker |
| DOMAIN_TO_ADMIN_KEY | admin / domain（domain → admin live-session introspection の専用鍵） |
| ADMIN_TO_<DOMAIN>_KEY | admin と対応する deployable domain。domain 0 件の雛形 production では不要（`ADMIN_TO_EXAMPLE_SERVICE_KEY` は dev/test 専用） |
| ADMIN_TO_NOTIFIER_KEY | admin と notifier |
| DOMAIN_TO_NOTIFIER_KEY | 各 domain Worker と notifier |
| OPS_TO_NOTIFIER_KEY | ops と notifier |
| AUTH_PEPPER | admin のみ |
| RESEND_API_KEY | notifier |
| D1_EXPORT_API_TOKEN | ops |
| R2_POLICY_CHECK_API_TOKEN | deploy/bootstrap/ops の R2 公開設定確認 |

JWT key pair は deploy.md の一時ファイル手順で生成する。private key を Tauri、ブラウザ、domain、CI artifact、Terraform state にコピーしない。

内部 API の鍵は caller と受信先の方向ごとに別のランダム値を生成する。複数の Worker に登録する場合も、その方向の両端だけに同じ値を登録し、別方向へ再利用しない。domain Worker ごとの `ADMIN_TO_<DOMAIN>_KEY` も別値にする必要があるが、現行 bootstrap が write 前に一意性を検査できるのは最大 1 deployable domain の bundle だけである。`DOMAIN_TO_ADMIN_KEY` は domain → admin live-session introspection の両端に置く専用鍵で、JWT_PRIVATE_KEY や admin → domain、domain → notifier の値とは分離する。生成した単一 domain bundle は GitHub `production` environment secret として登録し、protected workflow の allowlist 検査で bundle 内の全方向鍵重複を確認する。topology-wide multi-domain の一意性は保証せず、deployable domain が 2 件以上なら bootstrap は fail close する。全 domain key を一度に検査する bundle 設計が人間承認・実装されるまでは 1 domain に限定する。`scripts/put-production-secret.mjs` は validation-only で、ローカルから secret を書き込まない。

現行 catalog の deployable domain は 0 件であり、production domain token 発行経路も未実装である。issuer/key ownership を定義する gateway/IdP は人間承認が必要なアーキテクチャ変更とする。正規利用者が `aud=domain:<service>` と live `sid/sub/org` を持つ token を取得でき、成功、wrong audience、`sid` 欠落、logout/rotation、user/org 無効化、admin failure 503 を fixture で実行するまでは domain readiness を false とし、bootstrap/migration/deploy/secret provisioning を許可しない。

ローカルでは `make init` が validated catalog の全 SPA/Worker にある regular `.dev.vars.example` を 0600 の `.dev.vars` へコピーする。admin で生成した local RSA pair の `JWT_PUBLIC_KEY` / `AUTH_DEV_PRIVATE_KEY` は全 domain（両 example とコピー後に catalog 登録したサービス）へ配布する。symlink、catalog 外 path、部分 pair は fail close する。AUTH_DEV_GRANT=true と AUTH_DEV_PRIVATE_KEY はローカル credential-less grant 専用で、本番には登録しない。`AUTH_DEV_GRANT` だけを設定しても `/api/auth/token` は 404 のままになる。

## 6. マイグレーションと deploy

Worker の production deploy / remote migration は GitHub Actions の protected-main push
だけが実行する。作業前に CI が使う clean な main checkout と、取得済み `origin/main`
との commit 一致をローカルで確認し、実際の反映は PR merge 後の production environment
で行う。既存 Worker の secret 登録、remote seed、restore も protected `main` の
production workflow と required reviewer を通す。初回 Worker 作成を伴う secret
bootstrap は通常の deploy workflow やローカル CLI では行わず、
`.github/workflows/production-bootstrap.yml` の `workflow_dispatch` だけを使う。
この workflow は protected `main`、`production` environment の required reviewer、
コピー済み domain の入力検証、Worker ごとの secret allowlist を要求する。
`PRODUCTION_*` environment secrets の準備と、domain に JWT_PRIVATE_KEY を渡さない
allowlist の詳細は [deploy.md](./deploy.md) の 3-2 を参照する。

初回 bootstrap の前に、ops の backup bucket が非公開であることを確認する。さらに CI は
reviewed な account ID、R2 bucket、各 D1 の UUID/name を Cloudflare API の実リソースと
照合してから credentialed Wrangler を実行する。
`wrangler.jsonc` の R2 binding だけでは r2.dev managed domain や custom domain の公開設定を
無効化できないため、次の preflight は両方の設定を Cloudflare API で確認し、1 つでも有効・
取得不能なら停止する。

    node scripts/check-r2-private.mjs

本番 `latest.json` の署名用には、JWT pair と別に RSA pair を生成する。private half は
`PRODUCTION_BACKUP_SIGNING_PRIVATE_KEY` environment secret として ops へ登録し、public half は
review 済み `services/ops/wrangler.jsonc` の `vars.BACKUP_SIGNING_PUBLIC_KEY` に置く。
restore operator は public half だけを `BACKUP_SIGNING_PUBLIC_KEY` として使い、private half を
取得しない。

bootstrap は JWT と backup signer の RSA 型、2048 bit 以上、pair 一致、用途間の非再利用、
公開済み test key fingerprint の不一致を secret bundle write 前に検査する。固定順序は
`notifier bootstrap → admin remote migration（exactly once）→ admin bootstrap → domain remote migration（exactly once）→ domain bootstrap → ops bootstrap` であり、migration 失敗時は対応 deploy へ進まない。

    git fetch origin main --prune
    git status --short
    git branch --show-current
    test "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)"
    pnpm run test:deploy-boundary

本番用 Make target と package script は Cloudflare CLI の本番書き込み entry point を公開しない。production deploy / remote migration は protected-main push の CI guard、secret bootstrap / rotation・remote seed・restore は protected `main` の production workflow と required reviewer を必要とする。build には Cloudflare credential を渡さず、credentialed workflow は lockfile から検証した Wrangler を offline で固定コマンド実行する。`put-production-secret.mjs` は validation-only であり、ローカルの `PRODUCTION_WRANGLER_PATH` や raw Wrangler による書き込み手順は提供しない。example_service には本番 deploy target がない。

CI の deploy は `.github/workflows/ci.yml` の protected main push かつ production environment のみで起動する。workflow_dispatch は verify/e2e または unsigned Tauri artifact の検証用途であり、Cloudflare credential を持たない。bootstrap だけは `.github/workflows/production-bootstrap.yml` の workflow_dispatch を使えるが、protected main、selected main environment、required reviewer、入力値検証、secret allowlist を全て要求する。どちらも `id-token: write` や GitHub OIDC を使わない。

初回の secret bootstrap workflow は上記の production environment reviewer を通過した
場合だけ Cloudflare credential を利用する。`domain_service` に `example_service`、
`admin`、`notifier`、`ops`、またはパス形式などの値を渡しても拒否される。

## 7. 費用

このテンプレートは Workers Free の範囲で Workers / D1 / KV / R2 / Cron / Workflows を動かす設計である。Queues は採用していない。上限と対処は free-tier-limits.md を参照する。
