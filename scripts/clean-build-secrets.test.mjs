import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cleanBuildSecrets } from './clean-build-secrets.mjs'

test('removes generated .dev.vars files without following unrelated directories', () => {
  const parent = mkdtempSync(join(tmpdir(), 'build-secret-cleanup-'))
  const root = join(parent, 'dist')
  try {
    mkdirSync(join(root, 'admin'), { recursive: true })
    writeFileSync(join(root, 'admin', '.dev.vars'), 'JWT_PRIVATE_KEY=dev\n')
    writeFileSync(join(root, 'admin', 'index.js'), 'export {}\n')
    const outside = join(root, 'outside')
    writeFileSync(outside, 'keep\n')
    symlinkSync(outside, join(root, 'admin', 'outside-link'))

    assert.deepEqual(
      cleanBuildSecrets(root).map((path) => path.endsWith('admin/.dev.vars')),
      [true],
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('rejects broad or ambiguous cleanup paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'build-secret-cleanup-broad-'))
  try {
    assert.throws(() => cleanBuildSecrets(root), /not a service dist directory/)
    assert.throws(() => cleanBuildSecrets(join(root, 'service')), /not a service dist directory/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
