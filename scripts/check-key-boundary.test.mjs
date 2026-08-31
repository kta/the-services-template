import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findKeyBoundaryViolations } from './check-key-boundary.mjs'

const pemMarker = (label) => `-----BEGIN ${label}-----`
const testKey = `${pemMarker('PRIVATE KEY')}${'A'.repeat(128)}-----END PRIVATE KEY-----`

test('allows the fixed RSA fixture only at the shared test path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-boundary-'))
  try {
    await mkdir(join(root, 'packages/shared/test'), { recursive: true })
    await writeFile(join(root, 'packages/shared/test/jwt-keys.ts'), testKey)
    assert.deepEqual(await findKeyBoundaryViolations(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects private key material in production source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-boundary-'))
  try {
    await mkdir(join(root, 'services/admin/src'), { recursive: true })
    await writeFile(join(root, 'services/admin/src/leak.ts'), testKey)
    const violations = await findKeyBoundaryViolations(root)
    assert.equal(violations.length, 1)
    assert.match(violations[0], /services\/admin\/src\/leak\.ts/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects encrypted private key markers too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-boundary-'))
  try {
    await mkdir(join(root, 'services/admin/src'), { recursive: true })
    await writeFile(
      join(root, 'services/admin/src/encrypted.pem'),
      `${pemMarker('ENCRYPTED PRIVATE KEY')}\nshort\n`,
    )
    const violations = await findKeyBoundaryViolations(root)
    assert.equal(violations.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects private key material in non-code files too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-boundary-'))
  try {
    await mkdir(join(root, 'services/admin/config'), { recursive: true })
    await writeFile(join(root, 'services/admin/config/private.pem'), testKey)
    const violations = await findKeyBoundaryViolations(root)
    assert.equal(violations.length, 1)
    assert.match(violations[0], /services\/admin\/config\/private\.pem/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scans dotenv files other than the local .dev.vars file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-boundary-'))
  try {
    await mkdir(join(root, 'services/admin'), { recursive: true })
    await writeFile(join(root, 'services/admin/.env.production'), `JWT_PRIVATE_KEY=${testKey}`)
    const violations = await findKeyBoundaryViolations(root)
    assert.equal(violations.length, 1)
    assert.match(violations[0], /services\/admin\/\.env\.production/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scans a locally tracked .dev.vars file even when it was force-added', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-boundary-'))
  try {
    await mkdir(join(root, 'services/admin'), { recursive: true })
    await writeFile(join(root, 'services/admin/.dev.vars'), `JWT_PRIVATE_KEY=${testKey}`)
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '-f', 'services/admin/.dev.vars'], { cwd: root })
    const violations = await findKeyBoundaryViolations(root)
    assert.equal(violations.length, 1)
    assert.match(violations[0], /services\/admin\/\.dev\.vars/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects symlinks in every secret scan root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-boundary-'))
  try {
    await mkdir(join(root, 'services/admin'), { recursive: true })
    await symlink('/tmp', join(root, 'services/admin/linked-secret'))
    const violations = await findKeyBoundaryViolations(root)
    assert.equal(violations.length, 1)
    assert.match(violations[0], /symbolic links are forbidden/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows only the repository documentation pointer symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-boundary-'))
  try {
    await mkdir(join(root, 'services/admin'), { recursive: true })
    await writeFile(join(root, 'services/admin/AGENTS.md'), 'policy')
    await symlink('AGENTS.md', join(root, 'services/admin/CLAUDE.md'))
    assert.deepEqual(await findKeyBoundaryViolations(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
