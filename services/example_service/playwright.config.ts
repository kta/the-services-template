import { defineConfig, devices } from '@playwright/test'

function withDisposableState(command: string): string {
  return `E2E_STATE_PATH="$(mktemp -d)" && export E2E_STATE_PATH && trap 'rm -rf "$E2E_STATE_PATH"' EXIT && ${command}`
}

// Builds the service and serves it with `vite preview`, which runs the REAL
// Worker in workerd — the same-origin /api works, so e2e can exercise the full
// flow (dev-grant sign-in → create → list) against a fresh local D1 state on
// every run. The E2E command applies migrations itself; it never reuses the
// developer's `.wrangler/state`.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: withDisposableState(
        'pnpm exec wrangler dev -c e2e/notifier-failure.wrangler.jsonc --local --port 8788 --persist-to "$E2E_STATE_PATH"',
      ),
      url: 'http://localhost:8788/health',
      name: 'Notifier failure fixture',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: withDisposableState(
        'pnpm exec wrangler d1 migrations apply example_service --local --persist-to "$E2E_STATE_PATH" && pnpm run build && pnpm exec vite preview --port 4173 --strictPort',
      ),
      url: 'http://localhost:4173',
      name: 'Example service',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
