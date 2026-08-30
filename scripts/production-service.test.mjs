import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  productionServiceChildEnvironment,
  productionServiceGuardEnvironment,
  productionServiceInvocation,
} from './production-service.mjs'

const script = fileURLToPath(new URL('./production-service.mjs', import.meta.url))

test('rejects every production write action before resolving or spawning credentialed tools', () => {
  for (const [action, diagnostic] of [
    ['deploy', /CI-only.*protected main/i],
    ['migrate', /CI-only.*protected main/i],
    ['bootstrap', /workflow_dispatch.*protected main.*production environment/i],
  ]) {
    const result = spawnSync(process.execPath, [script, 'admin', action], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        PRODUCTION_PNPM_PATH: '/unreviewed/pnpm',
        CLOUDFLARE_API_TOKEN: 'must-not-reach-a-child',
        CLOUDFLARE_ACCOUNT_ID: 'must-not-reach-a-child',
      },
    })

    assert.notEqual(result.status, 0, `${action} must fail outside GitHub Actions`)
    assert.match(result.stderr, diagnostic, `${action} must fail at its protected workflow guard`)
    assert.doesNotMatch(result.stderr, /trusted absolute pnpm|pnpm must resolve/i)
  }
})

test('uses reviewed absolute tools and reconstructs a minimal credentialed child environment', () => {
  const catalog = {
    services: [{ directory: 'admin', package: '@app/admin', deployable: true }],
    workerOnlyServices: [],
  }
  assert.deepEqual(
    productionServiceGuardEnvironment(
      {
        HOME: '/runner',
        PATH: './rogue-bin',
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_PROTECTED: 'true',
        GITHUB_SHA: 'sha',
        CLOUDFLARE_API_TOKEN: 'must-not-reach-guard',
        NODE_OPTIONS: '--require=./rogue.cjs',
      },
      '/reviewed/node/bin/node',
    ),
    {
      HOME: '/runner',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: 'sha',
      PATH: '/usr/bin:/bin',
    },
  )
  assert.deepEqual(
    productionServiceInvocation('/workspace', catalog, 'admin', 'config', {
      nodePath: '/reviewed/node/bin/node',
    }),
    {
      command: '/reviewed/node/bin/node',
      args: ['/workspace/scripts/check-production-config.mjs', 'admin'],
      cwd: '/workspace',
    },
  )
  assert.deepEqual(
    productionServiceChildEnvironment(
      'deploy',
      {
        HOME: '/runner',
        PATH: './rogue-bin',
        CLOUDFLARE_API_TOKEN: 'token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
        NODE_OPTIONS: '--require=./rogue.cjs',
        NODE_PATH: './rogue-modules',
        PNPM_HOME: './rogue-pnpm',
        npm_config_userconfig: './rogue-npmrc',
      },
      {
        nodePath: '/reviewed/node/bin/node',
        pnpmPath: '/reviewed/pnpm/bin/pnpm',
      },
    ),
    {
      HOME: '/runner',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      PATH: '/reviewed/node/bin:/reviewed/pnpm/bin:/usr/local/bin:/usr/bin:/bin',
    },
  )
})
