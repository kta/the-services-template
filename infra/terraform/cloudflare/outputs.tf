# Copy these into the matching wrangler.jsonc files (database_id / binding ids).
output "admin_d1_database_id" {
  value       = cloudflare_d1_database.admin.id
  description = "services/admin/wrangler.jsonc → d1_databases[0].database_id (+ services/ops ADMIN_DB_ID var)"
}

output "dedupe_kv_namespace_id" {
  value       = cloudflare_workers_kv_namespace.dedupe.id
  description = "services/notifier/wrangler.jsonc → kv_namespaces[0].id (DEDUPE)"
}

output "backups_r2_bucket_name" {
  value       = cloudflare_r2_bucket.backups.name
  description = "services/ops/wrangler.jsonc → r2_buckets[0].bucket_name (BACKUPS)"
}
