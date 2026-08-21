import { applyD1Migrations, env } from 'cloudflare:test'

// Apply Drizzle-generated migrations to the test D1 once before tests run.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
