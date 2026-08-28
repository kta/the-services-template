import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { productionMigrationCommand } from './production-migrate.mjs'

test('uses the reviewed D1 binding and remote-only migration mode', () => {
  assert.deepEqual(productionMigrationCommand('admin'), [
    'd1',
    'migrations',
    'apply',
    'DB',
    '--remote',
  ])
  assert.throws(() => productionMigrationCommand('example_service'), /unknown production migration/)
})

test('refuses arbitrary Wrangler migration arguments', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/production-migrate.mjs', 'admin', '--config', 'attacker.jsonc'],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no Wrangler overrides/)
})
