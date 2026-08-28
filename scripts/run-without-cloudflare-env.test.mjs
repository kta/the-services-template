import assert from 'node:assert/strict'
import test from 'node:test'
import { withoutCloudflareEnvironment } from './run-without-cloudflare-env.mjs'

test('removes credentials and Wrangler override variables before a production build', () => {
  assert.deepEqual(
    withoutCloudflareEnvironment({
      CLOUDFLARE_API_TOKEN: 'secret',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      WRANGLER_SEND_METRICS: 'false',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
      ACTIONS_RUNTIME_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      PRODUCTION_AUTH_PEPPER: 'secret',
      BACKUP_SIGNING_PRIVATE_KEY: 'secret',
      AUTH_PEPPER: 'secret',
      APP_ENV: 'production',
      PATH: '/bin',
      SAFE_INPUT: 'must-not-cross',
    }),
    { APP_ENV: 'production', PATH: '/bin' },
  )
})

test('allows only explicit test fixtures when the build is explicitly in E2E mode', () => {
  const environment = {
    E2E_AUTH: 'true',
    E2E_STATE_PATH: '/tmp/e2e-state',
    AUTH_DEV_GRANT: 'true',
    AUTH_DEV_PRIVATE_KEY: 'test-key',
    AUTH_PEPPER: 'test-pepper',
    JWT_PRIVATE_KEY: 'test-private-key',
    PRODUCTION_AUTH_PEPPER: 'must-not-cross',
  }
  assert.deepEqual(withoutCloudflareEnvironment(environment), {
    E2E_AUTH: 'true',
    E2E_STATE_PATH: '/tmp/e2e-state',
    AUTH_DEV_GRANT: 'true',
    AUTH_DEV_PRIVATE_KEY: 'test-key',
    AUTH_PEPPER: 'test-pepper',
    JWT_PRIVATE_KEY: 'test-private-key',
  })
  assert.deepEqual(withoutCloudflareEnvironment({ E2E_AUTH: 'false', AUTH_DEV_GRANT: 'true' }), {})
})
