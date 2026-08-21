import { defineConfig, devices } from '@playwright/test'

// Builds the service and serves it with `vite preview`, which runs the REAL
// Worker in workerd — the same-origin /api works, so e2e can exercise the full
// flow (dev-grant sign-in → create → list) against local D1 state. Run
// `pnpm db:migrate:local` once before the first e2e run.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'pnpm run db:migrate:local && pnpm run build && pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
