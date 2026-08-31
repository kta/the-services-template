# Terraform — Cloudflare substrate

`cloudflare/cloudflare ~> 5`. Provisions the **stateful** resources (D1, KV, R2).
Worker **code + bindings** are deployed by Wrangler — Terraform and Wrangler each
own a resource exactly once to avoid drift. **No Queues**: they are available on
the free plan (since 2026-02), but this template deliberately does not use them —
notifications go through the notifier's sync send API instead (see `main.tf` and
`docs/howto/notifications.md`).

Use the repository-pinned Terraform **1.10.5 or newer within the 1.x major**:
`mise install` reads the version from the repository `mise.toml`. The S3 backend
uses `use_lockfile`, which is unavailable on older Terraform releases.

## Division of responsibility
| Owner | Resources |
|---|---|
| **Terraform** (here) | D1 databases, KV namespaces, R2 bucket |
| **Wrangler** (each `wrangler.jsonc`) | Worker code, bindings, cron triggers, secrets |

## Usage

このディレクトリには、本番リソースをローカル端末から作成・変更する write
entry point を置かない。Terraform の適用は、Terraform state を管理する組織の
protected `main` / required reviewer 付き infrastructure workflow から、レビュー
済み plan artifact を承認して実行する。ローカル端末に Cloudflare token を渡して
本番 state を変更する運用は許可しない。

ローカルでは credentialless な静的検査だけを実行できる。

```sh
terraform -chdir=infra/terraform/cloudflare fmt -check -diff
terraform -chdir=infra/terraform/cloudflare init -backend=false -input=false
terraform -chdir=infra/terraform/cloudflare validate
```

resource の作成後は、承認済み infrastructure workflow の output（D1 ID、KV ID、
R2 bucket 名）を PR で matching `wrangler.jsonc` に反映する。`example_service` は
本番用ではないため provision せず、fork 側で実ドメインの D1 を同じ protected
infrastructure workflow に追加する。

The application backup bucket must remain private. R2 bucket creation and the
`BACKUPS` binding do not by themselves disable the r2.dev managed domain or
custom-domain public access. Before a production bootstrap or deploy, run the
repository preflight from the root:

```sh
node scripts/check-r2-private.mjs
```

It fails closed unless the managed domain and every custom domain report public
access disabled. Do not add a public domain to the backup bucket. The preflight
uses the account and bucket in `services/ops/wrangler.jsonc`, and compares a
provided `CLOUDFLARE_ACCOUNT_ID` with that reviewed account.

For production Worker changes, merge into protected `main` and let the ordered
GitHub Actions production job run after verify. The repository deliberately has
no local Make/package entry point for production deploy or remote migration;
credentialed Wrangler commands exist only as fixed steps in the reviewed
production workflows. Raw `wrangler deploy` is not a production runbook command.

## State backend (R2)

The `versions.tf` backend is intentionally partial: bootstrap the state bucket
outside this stack first (it cannot be created by the stack that stores its
state), then initialize with values supplied only on the command line or via
environment variables. Use a bucket separate from the application backup
bucket.

```sh
set -euo pipefail
export AWS_ACCESS_KEY_ID       # R2 API token access key, entered out-of-band
export AWS_SECRET_ACCESS_KEY   # R2 API token secret, entered out-of-band
terraform init -migrate-state \
  -backend-config='bucket=terraform-state' \
  -backend-config='key=cloudflare/terraform.tfstate' \
  -backend-config='endpoints={"s3"="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"}'
```

R2 is S3-compatible (`region = "auto"`, path-style, skip flags), and the
configuration enables Terraform's `use_lockfile = true`. The first
`-migrate-state` run moves the local state created by the bootstrap step into the
R2 backend; review the migration prompt and do not use `-force-copy`. Later
backend changes must use `terraform init -migrate-state` again. Keep a CI
concurrency group or an equivalent single-writer rule as an additional
operational guard.
Do not put the endpoint credentials in `terraform.tfvars`, source, or CI logs.

## Secrets
Worker secret の本番値は Terraform では管理しない。`secret_text` binding は TF
state に値を残すため禁止する。値は GitHub `production` environment secret として
登録し、protected bootstrap/rotation workflow の allowlist からだけ Worker へ
渡す。`scripts/put-production-secret.mjs` はポリシー検査を再利用するための
validation-only module であり、ローカルから `wrangler secret put` は実行しない。

The matching `BACKUP_SIGNING_PUBLIC_KEY` is intentionally a reviewed public
value in `services/ops/wrangler.jsonc` vars. It is a separate RSA pair from the
JWT signing key. Production ops signs `latest.json`; the restore wrapper verifies
that signature before accepting target/account/database provenance.
