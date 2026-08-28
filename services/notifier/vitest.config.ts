import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // wrangler vars から機密を撤去したぶん、テストは自前で dev 値を供給する
      miniflare: {
        bindings: {
          APP_ENV: 'development',
          ADMIN_TO_NOTIFIER_KEY: 'dev-admin-to-notifier-key-000000000000',
          DOMAIN_TO_NOTIFIER_KEY: 'dev-domain-to-notifier-key-000000000000',
          OPS_TO_NOTIFIER_KEY: 'dev-ops-to-notifier-key-000000000000',
          RESEND_API_KEY: '',
          MAIL_DEV_LOG: 'true',
          DOMAIN_NOTIFICATION_TO: 'team@example.com',
          OPS_ALERT_EMAIL: 'ops@example.com',
          INVITE_BASE_URL: 'https://app.test',
        },
      },
    }),
  ],
  test: {
    coverage: {
      provider: 'istanbul',
      reporter: ['text'],
      include: ['src/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
