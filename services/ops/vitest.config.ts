import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // wrangler vars から機密を撤去したぶん、テストは自前で dev 値を供給する
        bindings: {
          OPS_TO_NOTIFIER_KEY: 'dev-ops-to-notifier-key',
          D1_EXPORT_API_TOKEN: 'dev-d1-export-token',
          R2_POLICY_CHECK_API_TOKEN: 'dev-r2-policy-check-token',
          APP_ENV: 'development',
          OPS_ALERT_EMAIL: 'ops@example.com',
          // Keep tests independent from the intentionally invalid production
          // placeholders in wrangler.jsonc. These are valid-shaped fixtures so
          // metadata binding checks exercise the success path as well.
          CF_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ADMIN_DB_ID: '12345678-1234-4234-8234-123456789abc',
          BACKUP_BUCKET_NAME: 'app-backups',
        },
        // Stub the cross-service bindings so the isolate starts; tests spy on
        // env.NOTIFIER.fetch / env.ADMIN.fetch to assert calls.
        serviceBindings: {
          NOTIFIER: () => new Response('{"status":"sent"}', { status: 200 }),
          ADMIN: () => new Response('{"status":"ok"}', { status: 200 }),
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text'],
      // d1-export.ts is thin HTTP orchestration exercised via mocked fetch in the
      // integration test; lib/backup.ts is fully unit-tested.
      include: ['src/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
