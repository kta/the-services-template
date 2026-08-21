# Stateful Cloudflare substrate. Worker CODE and per-Worker bindings are owned
# by Wrangler (each wrangler.jsonc) — Terraform only provisions the resources
# below and exports their IDs (see outputs.tf) to wire into wrangler.jsonc.
# One owner per resource avoids drift.

# --- D1: one database per domain (no cross-D1 joins; reconcile in app code) ---
# Production users: add `lifecycle { prevent_destroy = true }` to each D1 below
# so a rename/destroy can't silently drop the database. Omitted in the template
# because you WILL rename `example_service` when copying it.
resource "cloudflare_d1_database" "example_service" {
  account_id = var.cloudflare_account_id
  name       = "example_service"
}

resource "cloudflare_d1_database" "admin" {
  account_id = var.cloudflare_account_id
  name       = "admin"
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
}

# admin: login rate-limit / lockout counters (email+IP window).
resource "cloudflare_workers_kv_namespace" "auth_rl" {
  account_id = var.cloudflare_account_id
  title      = "admin-auth-rl"
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
  # Production: add `lifecycle { prevent_destroy = true }` — this bucket is the
  # only off-D1 copy (restore.md). A rename/destroy would drop all DR
  # generations. Omitted in the template so the name can be changed on adoption.
}

resource "cloudflare_r2_bucket_lifecycle" "backups" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.backups.name
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
