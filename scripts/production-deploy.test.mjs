import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  forbiddenProductionDeployArgs,
  isProductionService,
  productionDeployCommand,
} from './production-deploy.mjs'

test('only reviewed service directories can reach the production deploy wrapper', async () => {
  assert.equal(await isProductionService('admin'), true)
  assert.equal(await isProductionService('notifier'), true)
  assert.equal(await isProductionService('example_service'), false)
  assert.equal(await isProductionService('example_tauri_service'), false)
  assert.equal(await isProductionService('../attacker'), false)
  assert.equal(await isProductionService('missing_service'), false)
})

test('rejects Wrangler flags that can replace production identity or secrets', () => {
  assert.deepEqual(
    forbiddenProductionDeployArgs([
      '--env=staging',
      '--var',
      'APP_ENV:development',
      '--secrets-file=.dev.vars',
      '--keep-vars',
      '--config',
    ]),
    ['--env=staging', '--var', '--secrets-file=.dev.vars', '--keep-vars', '--config'],
  )
  assert.deepEqual(forbiddenProductionDeployArgs([]), [])
})

test('deploys only reviewed prebuilt bundles with the fixed Wrangler config', () => {
  assert.deepEqual(productionDeployCommand('notifier'), [
    'deploy',
    'dist/index.js',
    '--no-bundle',
    '--config=wrangler.jsonc',
  ])
  assert.deepEqual(productionDeployCommand('admin'), [
    'deploy',
    'dist/admin/index.js',
    '--no-bundle',
    '--config=wrangler.jsonc',
    '--assets=dist/client',
  ])
  assert.deepEqual(productionDeployCommand('booking'), [
    'deploy',
    'dist/booking/index.js',
    '--no-bundle',
    '--config=wrangler.jsonc',
    '--assets=dist/client',
  ])
})

test('CLI refuses extra deploy arguments before Wrangler can run', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/production-deploy.mjs', 'admin', '--var=x'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Wrangler overrides are not accepted/)
})
