import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { productionArtifactPlan } from './production-artifacts.mjs'
import { productionServiceInvocation } from './production-service.mjs'

const catalog = {
  services: [
    { directory: 'admin', package: '@app/admin', deployable: true, native: true },
    { directory: 'booking', package: '@app/booking', deployable: true, native: false },
    {
      directory: 'example_service',
      package: '@app/example_service',
      deployable: false,
      native: false,
    },
  ],
  workerOnlyServices: [
    { directory: 'notifier', package: '@app/notifier', deployable: true },
    { directory: 'ops', package: '@app/ops', deployable: true },
  ],
}

test('production service wrapper derives selector, cwd, entry, and config from catalog identity', () => {
  assert.deepEqual(
    productionServiceInvocation('/workspace', catalog, 'booking', 'build', {
      pnpmPath: '/trusted/pnpm',
    }),
    {
      command: '/trusted/pnpm',
      args: ['--filter', '@app/booking', 'run', 'build'],
      cwd: '/workspace',
    },
  )
  assert.deepEqual(
    productionServiceInvocation('/workspace', catalog, 'admin', 'migrate', {
      pnpmPath: '/trusted/pnpm',
    }),
    {
      command: '/trusted/pnpm',
      args: [
        '--config.offline=true',
        'exec',
        'wrangler',
        'd1',
        'migrations',
        'apply',
        'DB',
        '--remote',
        '--config=wrangler.jsonc',
      ],
      cwd: '/workspace/services/admin',
    },
  )
  assert.deepEqual(
    productionServiceInvocation('/workspace', catalog, 'booking', 'bootstrap', {
      pnpmPath: '/trusted/pnpm',
      runnerTemp: '/runner/temp',
    }),
    {
      command: '/trusted/pnpm',
      args: [
        '--config.offline=true',
        'exec',
        'wrangler',
        'deploy',
        'dist/booking/index.js',
        '--no-bundle',
        '--config=wrangler.jsonc',
        '--assets=dist/client',
        '--secrets-file=/runner/temp/production-secret-bundles/domain.json',
      ],
      cwd: '/workspace/services/booking',
    },
  )
  assert.deepEqual(
    productionServiceInvocation('/workspace', catalog, 'admin', 'remote-secrets').args,
    ['/workspace/scripts/check-production-secrets.mjs', 'admin', '--deploy'],
  )
  assert.deepEqual(
    productionServiceInvocation('/workspace', catalog, 'admin', 'remote-secrets-bootstrap').args,
    ['/workspace/scripts/check-production-secrets.mjs', 'admin', '--allow-missing-worker'],
  )
})

test('production service wrapper rejects nondeployable, unknown, worker migration, and path-like identities', () => {
  for (const directory of ['example_service', 'admin/../booking', 'rogue']) {
    assert.throws(
      () => productionServiceInvocation('/workspace', catalog, directory, 'build'),
      /catalog deployable service/i,
    )
  }
  assert.throws(
    () => productionServiceInvocation('/workspace', catalog, 'notifier', 'migrate'),
    /migration requires a catalog SPA service/i,
  )
  assert.throws(
    () => productionServiceInvocation('/workspace', catalog, 'admin', 'guard-domain'),
    /catalog deployable domain service/i,
  )
  assert.throws(
    () =>
      productionServiceInvocation('/workspace', catalog, 'admin', 'deploy', {
        pnpmPath: 'pnpm',
      }),
    /trusted absolute pnpm path/i,
  )
})

test('production artifact wrapper fixes archive paths and exact catalog service collections', () => {
  assert.deepEqual(
    productionArtifactPlan('/workspace', catalog, 'ci', 'package', [
      'admin',
      'booking',
      'notifier',
      'ops',
    ]),
    {
      archivePath: '/workspace/production-worker-bundles.tar.gz',
      manifestPath: '/workspace/production-worker-manifest.json',
      serviceDirectories: ['admin', 'booking', 'notifier', 'ops'],
      distPaths: [
        'services/admin/dist',
        'services/booking/dist',
        'services/notifier/dist',
        'services/ops/dist',
      ],
    },
  )
  assert.equal(
    productionArtifactPlan('/workspace', catalog, 'bootstrap', 'install', [
      'admin',
      'notifier',
      'ops',
      'booking',
    ]).archivePath,
    join('/workspace', 'production-bootstrap-worker-bundles.tar.gz'),
  )
})

test('production artifact wrapper rejects missing, duplicate, traversal, and nondeployable argv', () => {
  for (const directories of [
    ['admin', 'notifier', 'ops'],
    ['admin', 'booking', 'notifier', 'ops', 'ops'],
    ['admin/../booking', 'booking', 'notifier', 'ops'],
    ['admin', 'example_service', 'notifier', 'ops'],
  ]) {
    assert.throws(
      () => productionArtifactPlan('/workspace', catalog, 'ci', 'package', directories),
      /must exactly match catalog deployable services/i,
    )
  }
})
