terraform {
  required_version = ">= 1.9, < 2.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State backend on R2 (S3-compatible). Uncomment and fill in after creating
  # the bucket + an R2 API token. R2 has no native state locking, so serialize
  # applies (e.g. a CI concurrency group).
  #
  # backend "s3" {
  #   bucket = "tfstate"
  #   key    = "cloudflare/terraform.tfstate"
  #   region = "auto"
  #   endpoints                   = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  # }
}

# Reads CLOUDFLARE_API_TOKEN from the environment. Scope the token minimally:
# Account: D1 Edit, Workers KV Storage Edit, Workers R2 Storage Edit, Account
# Settings Read. (No Queues — free-tier policy; Workflows/R2 lifecycle need no
# extra TF-token scope beyond R2 Edit.)
provider "cloudflare" {}
