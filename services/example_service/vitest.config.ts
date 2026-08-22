import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Runs tests inside workerd (Miniflare) with the real bindings from
// wrangler.jsonc. D1 migrations are read in Node and injected as a binding,
// then applied to the test DB in test/setup.ts.
const migrations = await readD1Migrations('./migrations')

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // wrangler vars から機密を撤去したぶん、テストは自前で dev 値を供給する
          INTERNAL_KEY: 'dev-internal-key',
          JWT_SECRET: 'dev-jwt-secret-change-me',
          AUTH_DEV_GRANT: 'true',
        },
        // Stub the notifier binding so the isolate starts; the create test spies
        // on env.NOTIFIER.fetch to assert the notification call.
        serviceBindings: { NOTIFIER: () => new Response('{}', { status: 200 }) },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'], // NOT e2e/ — those are Playwright specs
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'istanbul', // V8 coverage is unsupported in the Workers pool
      reporter: ['text'],
      include: ['src/worker/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
