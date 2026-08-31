import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// D1 is SQLite. Conventions:
// - No foreign keys; integrity is enforced in the app layer.
// - IDs are app-generated (crypto.randomUUID, v4), not DB defaults.
// - Every domain row carries organization_id for tenant scoping.
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  // Matches the tenant-scoped list query: WHERE organization_id = ? ORDER BY created_at DESC.
  (t) => [index('items_org_created_idx').on(t.organizationId, t.createdAt)],
)

// Synced copy of organizations (source of truth is the admin domain). Kept
// here because D1 has no cross-database joins — reconcile in app code.
// plan / is_disabled are read on every tenant request (requireActiveOrg). The
// sync timestamp is a lease: if the admin→domain reconciliation stops, the
// domain fails closed instead of trusting an indefinitely stale enabled row.
// Legacy rows are backfilled by the generated migrations before the final
// schema makes the replay fence non-null; incomplete rows are rejected by the
// app layer rather than receiving a permissive default.
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan'), // 'free' | 'contracted'
  isDisabled: text('is_disabled'), // '0' | '1'
  // Monotonic admin-source revision; stale sync payloads must never win.
  version: integer('version').notNull(),
  syncedAt: text('synced_at'), // admin sync receipt time; stale/null rows fail closed
  createdAt: text('created_at').notNull(),
})
