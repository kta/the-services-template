import { defineConfig } from 'drizzle-kit'

// `out` must equal wrangler's `migrations_dir` (./migrations). Apply with
// `wrangler d1 migrations apply`, not `drizzle-kit migrate`.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/worker/db/schema.ts',
  out: './migrations',
})
