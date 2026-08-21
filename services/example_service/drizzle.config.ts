import { defineConfig } from 'drizzle-kit'

// Generates SQL migrations from the Drizzle schema into ./migrations, which is
// also wrangler's `migrations_dir`. Apply them with `wrangler d1 migrations
// apply` (NOT `drizzle-kit migrate`) so local Miniflare and remote D1 stay in
// sync through the binding.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/worker/db/schema.ts',
  out: './migrations',
})
