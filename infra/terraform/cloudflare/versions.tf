terraform {
  # use_lockfile is the native S3 state-locking feature introduced in 1.10.
  required_version = ">= 1.10, < 2.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Partial state backend on R2 (S3-compatible). Supply bucket, key, endpoint,
  # and credentials with `terraform init -backend-config=...` (never commit
  # those values). `use_lockfile` provides Terraform's S3 lockfile; still
  # serialize applies with a CI concurrency group because the backend bucket is
  # an operational single-writer boundary. Bootstrap instructions live in the
  # Terraform README.
  backend "s3" {
    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
    use_lockfile                = true
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment. Scope the token minimally:
# Account: D1 Edit, Workers KV Storage Edit, Workers R2 Storage Edit, Account
# Settings Read. (No Queues — free-tier policy; Workflows/R2 lifecycle need no
# extra TF-token scope beyond R2 Edit.)
provider "cloudflare" {}
