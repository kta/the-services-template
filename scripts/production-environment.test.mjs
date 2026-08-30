import assert from 'node:assert/strict'
import test from 'node:test'
import {
  productionCloudflareEnvironment,
  productionEnvironment,
  productionGuardEnvironment,
} from './production-environment.mjs'

test('keeps only the reviewed execution environment and removes process overrides', () => {
  assert.deepEqual(
    productionEnvironment({
      PATH: '/usr/bin',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_BASE_URL: 'https://evil.example',
      CLOUDFLARE_API_KEY: 'legacy-key',
      WRANGLER_CONFIG: '/tmp/attacker.jsonc',
      WRANGLER_ENV: 'staging',
      NODE_OPTIONS: '--require=/tmp/attacker.js',
      NODE_PATH: '/tmp/attacker-modules',
      npm_config_userconfig: '/tmp/attacker.npmrc',
      PNPM_CONFIG_DIR: '/tmp/attacker-pnpm',
      GIT_CONFIG_COUNT: '1',
      BASH_ENV: '/tmp/attacker.sh',
      SAFE_INPUT: 'kept',
      HOME: '/Users/test',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: 'sha',
      HTTPS_PROXY: 'http://proxy.attacker',
    }),
    {
      PATH: '/usr/bin',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      HOME: '/Users/test',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: 'sha',
    },
  )
})

test('removes non-reviewed CI token variables before invoking Cloudflare tools', () => {
  const environment = {
    CLOUDFLARE_API_TOKEN: 'token',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
    GITHUB_REPOSITORY: 'kta/the-services-template',
  }
  assert.deepEqual(productionCloudflareEnvironment(environment), {
    CLOUDFLARE_API_TOKEN: 'token',
    CLOUDFLARE_ACCOUNT_ID: 'account',
  })
})

test('gives checkout guards public GitHub context without Cloudflare credentials or Node injection', () => {
  assert.deepEqual(
    productionGuardEnvironment({
      PATH: '/reviewed/bin',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: 'reviewed-sha',
      CLOUDFLARE_API_TOKEN: 'must-not-reach-guard',
      CLOUDFLARE_ACCOUNT_ID: 'must-not-reach-guard',
      NODE_OPTIONS: '--require=./rogue.cjs',
      NODE_PATH: './rogue-modules',
    }),
    {
      PATH: '/reviewed/bin',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: 'reviewed-sha',
    },
  )
})
