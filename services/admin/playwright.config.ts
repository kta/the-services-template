import { defineConfig, devices } from '@playwright/test'

function withDisposableState(command: string): string {
  return `E2E_STATE_PATH="$(mktemp -d)" && export E2E_STATE_PATH && trap 'rm -rf "$E2E_STATE_PATH"' EXIT && ${command}`
}

// Builds the service and serves it with `vite preview` (real Worker in
// workerd). The EXAMPLE_SERVICE binding has no running peer during e2e; org
// creation still succeeds because the sync is best-effort by design. Every
// run migrates an independent D1 state, so prior invitations cannot leak in.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://localhost:4174', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: withDisposableState(
      'pnpm exec wrangler d1 migrations apply admin --local --persist-to "$E2E_STATE_PATH" && pnpm run build && pnpm exec vite preview --port 4174 --strictPort',
    ),
    url: 'http://localhost:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
