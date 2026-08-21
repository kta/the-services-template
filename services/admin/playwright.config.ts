import { defineConfig, devices } from '@playwright/test'

// Builds the service and serves it with `vite preview` (real Worker in
// workerd). The EXAMPLE_SERVICE binding has no running peer during e2e; org
// creation still succeeds because the sync is best-effort by design.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://localhost:4174', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'pnpm run db:migrate:local && pnpm run build && pnpm exec vite preview --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
