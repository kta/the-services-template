import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
// plan / is_disabled are read on every tenant request (requireActiveOrg), so
// admin-side changes take effect immediately. Nullable on purpose (no DDL
// defaults per convention; ALTER TABLE ADD COLUMN can't be NOT NULL without
// one) — the app layer treats null plan as 'free', null is_disabled as '0'.
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan'), // 'free' | 'contracted'(null は 'free' 扱い)
  isDisabled: text('is_disabled'), // '0' | '1'(null は '0' 扱い)
  createdAt: text('created_at').notNull(),
})
