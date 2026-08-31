import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveProductionWrangler } from './production-wrangler.mjs'

test('requires an absolute, owner-only Wrangler executable outside the checkout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-wrangler-'))
  try {
    const target = join(directory, 'wrangler.js')
    const link = join(directory, 'wrangler')
    writeFileSync(target, '#!/usr/bin/env node\n')
    chmodSync(target, 0o755)
    symlinkSync(target, link)
    assert.equal(
      resolveProductionWrangler({ PRODUCTION_WRANGLER_PATH: link }, process.cwd()),
      realpathSync(target),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects missing, writable, wrong-name, and checkout-local Wrangler paths', () => {
  assert.throws(
    () => resolveProductionWrangler({ PRODUCTION_WRANGLER_PATH: 'wrangler' }),
    /absolute path/,
  )
  const directory = mkdtempSync(join(tmpdir(), 'production-wrangler-'))
  try {
    const wrongName = join(directory, 'node')
    writeFileSync(wrongName, '#!/bin/sh\n')
    chmodSync(wrongName, 0o755)
    assert.throws(
      () => resolveProductionWrangler({ PRODUCTION_WRANGLER_PATH: wrongName }),
      /pinned Wrangler/,
    )
    const writable = join(directory, 'wrangler')
    writeFileSync(writable, '#!/bin/sh\n')
    chmodSync(writable, 0o775)
    assert.throws(
      () => resolveProductionWrangler({ PRODUCTION_WRANGLER_PATH: writable }),
      /non-writable/,
    )
    assert.throws(
      () =>
        resolveProductionWrangler({ PRODUCTION_WRANGLER_PATH: join(process.cwd(), 'wrangler') }),
      /existing executable|inside the repository/,
    )
    const checkout = join(directory, 'checkout')
    mkdirSync(checkout)
    symlinkSync(writable, join(checkout, 'wrangler'))
    assert.throws(
      () =>
        resolveProductionWrangler(
          { PRODUCTION_WRANGLER_PATH: join(checkout, 'wrangler') },
          checkout,
        ),
      /inside the repository|non-writable/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
