# Terraform — Cloudflare substrate

`cloudflare/cloudflare ~> 5`. Provisions the **stateful** resources (D1, KV, R2).
Worker **code + bindings** are deployed by Wrangler — Terraform and Wrangler each
own a resource exactly once to avoid drift. **No Queues**: they are available on
the free plan (since 2026-02), but this template deliberately does not use them —
notifications go through the notifier's sync send API instead (see `main.tf` and
`docs/howto/notifications.md`).

## Division of responsibility
| Owner | Resources |
|---|---|
| **Terraform** (here) | D1 databases, KV namespaces, R2 bucket |
| **Wrangler** (each `wrangler.jsonc`) | Worker code, bindings, cron triggers, secrets |

## Usage
> **Prereq**: a brand-new Cloudflare account must enable R2 once (dashboard → R2 →
> accept terms) before `terraform apply`, or the `cloudflare_r2_bucket` resources fail.

```sh
export CLOUDFLARE_API_TOKEN=...        # Account: D1/KV/R2 Edit + Account Read
cp terraform.tfvars.example terraform.tfvars   # set account id
terraform init
terraform apply
terraform output                       # ids to copy into wrangler.jsonc
```

Then put the output ids into the matching `wrangler.jsonc` (`database_id`,
KV `id`) and `wrangler deploy` each Worker.

## State backend (R2)
Uncomment the `backend "s3"` block in `versions.tf` and point it at an R2
bucket. R2 is S3-compatible (`region = "auto"`, path-style, skip flags) but has
**no native locking** — serialize `apply` (e.g. a CI concurrency group).

## Secrets
Set via `wrangler secret put` (e.g. `INTERNAL_KEY`, `RESEND_API_KEY`), **not**
Terraform — `secret_text` bindings would land in TF state.
