import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveProductionPnpm } from './production-pnpm.mjs'

test('resolves and validates the PATH pnpm when no override is supplied', () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-pnpm-'))
  try {
    const executable = join(directory, 'pnpm')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    assert.equal(
      resolveProductionPnpm({ PATH: directory }, process.cwd()),
      realpathSync(executable),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('accepts an owned executable pnpm path and resolves symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-pnpm-'))
  try {
    const target = join(directory, 'pnpm.js')
    const link = join(directory, 'pnpm')
    writeFileSync(target, '#!/bin/sh\n')
    chmodSync(target, 0o755)
    symlinkSync(target, link)
    assert.equal(resolveProductionPnpm({ PRODUCTION_PNPM_PATH: link }), realpathSync(target))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects invalid, writable, foreign, or checkout-local overrides', () => {
  assert.throws(() => resolveProductionPnpm({ PATH: '/missing-production-pnpm' }), /PATH/)
  assert.throws(() => resolveProductionPnpm({ PRODUCTION_PNPM_PATH: 'pnpm' }), /absolute path/)

  const directory = mkdtempSync(join(tmpdir(), 'production-pnpm-'))
  try {
    const executable = join(directory, 'not-pnpm')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    assert.throws(
      () => resolveProductionPnpm({ PRODUCTION_PNPM_PATH: executable }),
      /pnpm executable/,
    )
    chmodSync(executable, 0o775)
    assert.throws(() => resolveProductionPnpm({ PRODUCTION_PNPM_PATH: executable }), /non-writable/)

    const pnpm = join(directory, 'pnpm')
    writeFileSync(pnpm, '#!/bin/sh\n')
    chmodSync(pnpm, 0o755)
    assert.throws(
      () => resolveProductionPnpm({ PRODUCTION_PNPM_PATH: pnpm }, directory),
      /inside the repository/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
