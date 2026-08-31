# Stateful Cloudflare substrate. Worker CODE and per-Worker bindings are owned
# by Wrangler (each wrangler.jsonc) — Terraform only provisions the resources
# below and exports their IDs (see outputs.tf) to wire into wrangler.jsonc.
# One owner per resource avoids drift.

# --- D1: admin owns auth/org data; each copied domain adds its own D1 ---
# The example_service D1 was present in the original template but the service is
# a non-production scaffold. Stop managing it without destroying an existing
# database; a real copied domain must add its D1 in a reviewed change.
removed {
  from = cloudflare_d1_database.example_service

  lifecycle {
    destroy = false
  }
}

resource "cloudflare_d1_database" "admin" {
  account_id = var.cloudflare_account_id
  name       = "admin"

  lifecycle {
    prevent_destroy = true
  }
}

# --- No Queues (free-tier policy) ---
# Cloudflare Queues require Workers Paid. The whole stack runs on the free
# tier: async notification is a synchronous service-binding call to the
# notifier Worker's POST /api/internal/send, not a queue (see
# docs/howto/notifications.md). Do not add cloudflare_queue resources.

# --- KV ---
# notifier: idempotency (dedupe) store for POST /api/internal/send.
resource "cloudflare_workers_kv_namespace" "dedupe" {
  account_id = var.cloudflare_account_id
  title      = "notifier-dedupe"

  lifecycle {
    prevent_destroy = true
  }
}

# Legacy admin rate-limit KV. Current code uses the atomic D1 table instead.
# Stop managing an existing namespace without destroying it; this avoids both
# a fresh unused KV allocation and an accidental deletion during migration.
removed {
  from = cloudflare_workers_kv_namespace.auth_rl

  lifecycle {
    destroy = false
  }
}

# ops: backup generations (D1 REST export → validate → put). Private bucket,
# minimal-scope token (see docs/howto/restore.md). The ops Worker prunes to 30
# generations (~15 days); this lifecycle is a second safety net at 16 days.
resource "cloudflare_r2_bucket" "backups" {
  account_id = var.cloudflare_account_id
  name       = "app-backups"
  # Keep data close to your users (location hint, best-effort — NOT a legal
  # data-residency guarantee). Pick the hint that matches your market.
  location = "apac"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lifecycle" "backups" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.backups.name

  lifecycle {
    prevent_destroy = true
  }

  rules = [{
    id      = "expire-16d"
    enabled = true
    conditions = {
      prefix = "" # all objects
    }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = 16 * 24 * 60 * 60 # 16 days in seconds
      }
    }
  }]
}
