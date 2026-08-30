import { defineConfig, devices } from '@playwright/test'
import { JWT_TEST_PRIVATE_KEY, JWT_TEST_PUBLIC_KEY } from '../../packages/shared/test/jwt-keys'
import { fixtureSecret } from './e2e/fixture-secret'

export const E2E_FIXTURE_CONTROL_TOKEN = fixtureSecret('E2E_FIXTURE_CONTROL_TOKEN', process.env)
export const E2E_FIXTURE_INTERNAL_KEY = fixtureSecret('E2E_FIXTURE_INTERNAL_KEY', process.env)

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
  use: { baseURL: 'http://localhost:4175', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: withDisposableState(
        `pnpm exec wrangler dev -c e2e/notifier-failure.wrangler.jsonc --local --port 8789 --persist-to "$E2E_STATE_PATH" --var E2E_FIXTURE_CONTROL_TOKEN:${E2E_FIXTURE_CONTROL_TOKEN} --var E2E_FIXTURE_INTERNAL_KEY:${E2E_FIXTURE_INTERNAL_KEY}`,
      ),
      url: 'http://localhost:8789/health',
      name: 'Notifier failure fixture',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: withDisposableState(
        'pnpm exec wrangler d1 migrations apply example_tauri_service --local --persist-to "$E2E_STATE_PATH" && pnpm run build && pnpm exec vite preview --port 4175 --strictPort',
      ),
      env: {
        APP_ENV: 'development',
        AUTH_DEV_GRANT: 'true',
        AUTH_DEV_PRIVATE_KEY: JWT_TEST_PRIVATE_KEY,
        E2E_AUTH: 'true',
        ADMIN_TO_EXAMPLE_TAURI_SERVICE_KEY: 'e2e-admin-to-example-tauri-service-key',
        DOMAIN_TO_NOTIFIER_KEY: E2E_FIXTURE_INTERNAL_KEY,
        JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY,
      },
      url: 'http://localhost:4175',
      name: 'Example Tauri service',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
