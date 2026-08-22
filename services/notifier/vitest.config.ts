import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // wrangler vars から機密を撤去したぶん、テストは自前で dev 値を供給する
      miniflare: {
        bindings: { INTERNAL_KEY: 'dev-internal-key', RESEND_API_KEY: '', MAIL_DEV_LOG: 'true' },
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
