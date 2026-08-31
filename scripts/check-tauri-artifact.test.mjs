import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { scanTauriArtifacts } from './check-tauri-artifact.mjs'

const execFileAsync = promisify(execFile)
const pemMarker = (label) => `-----BEGIN ${label}-----`

async function withFixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'tauri-artifact-'))
  try {
    await mkdir(join(root, 'bundle', 'nested'), { recursive: true })
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('accepts an artifact without Worker credentials', async () => {
  await withFixture(async (root) => {
    await writeFile(join(root, 'bundle', 'app.js'), 'const origin = "https://app.example.com"\n')
    assert.deepEqual(await scanTauriArtifacts(['bundle'], root), [])
  })
})

test('rejects secret names and private-key markers without echoing values', async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, 'bundle', 'app.js'),
      `JWT_PRIVATE_KEY=VALUE_SHOULD_NOT_ECHO\n${pemMarker('PRIVATE KEY')}\nPAYLOAD_SHOULD_NOT_ECHO\n`,
    )
    const violations = await scanTauriArtifacts(['bundle'], root)
    assert.equal(violations.length, 2)
    assert.ok(violations.some((violation) => violation.includes('JWT_PRIVATE_KEY')))
    assert.ok(violations.some((violation) => violation.includes('BEGIN PRIVATE KEY')))
    assert.ok(violations.every((violation) => !violation.includes('VALUE_SHOULD_NOT_ECHO')))
    assert.ok(violations.every((violation) => !violation.includes('PAYLOAD_SHOULD_NOT_ECHO')))
  })
})

test('rejects copied-domain direction keys by pattern, not only by the scaffold name', async () => {
  await withFixture(async (root) => {
    await writeFile(join(root, 'bundle', 'app.js'), 'const key = "ADMIN_TO_BOOKING_KEY"\n')
    const violations = await scanTauriArtifacts(['bundle'], root)
    assert.equal(violations.length, 1)
    assert.match(violations[0], /ADMIN_TO_BOOKING_KEY/)
  })
})

test('rejects every ops credential marker, including opaque policy and signing names', async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, 'bundle', 'ops.js'),
      'const policy = "R2_POLICY_CHECK_API_TOKEN"; const signing = "BACKUP_SIGNING_PRIVATE_KEY"\n',
    )
    const violations = await scanTauriArtifacts(['bundle'], root)
    assert.equal(violations.length, 2)
    assert.ok(violations.some((violation) => violation.includes('R2_POLICY_CHECK_API_TOKEN')))
    assert.ok(violations.some((violation) => violation.includes('BACKUP_SIGNING_PRIVATE_KEY')))
  })
})

test('detects a generic secret-like marker split across file read chunks', async () => {
  await withFixture(async (root) => {
    const prefix = `${'x'.repeat(65536 - 10)} `
    await writeFile(join(root, 'bundle', 'split.js'), `${prefix}ADMIN_TO_BOOKING_KEY\n`)
    const violations = await scanTauriArtifacts(['bundle'], root)
    assert.ok(violations.some((violation) => violation.includes('ADMIN_TO_BOOKING_KEY')))
  })
})

test('rejects encrypted private-key markers', async () => {
  await withFixture(async (root) => {
    await writeFile(
      join(root, 'bundle', 'encrypted.pem'),
      `${pemMarker('ENCRYPTED PRIVATE KEY')}\nPAYLOAD_SHOULD_NOT_ECHO\n`,
    )
    const violations = await scanTauriArtifacts(['bundle'], root)
    assert.equal(violations.length, 1)
    assert.match(violations[0], /ENCRYPTED PRIVATE KEY/)
    assert.doesNotMatch(violations[0], /PAYLOAD_SHOULD_NOT_ECHO/)
  })
})

test('rejects a symlink that escapes the artifact root', async () => {
  await withFixture(async (root) => {
    const outside = join(root, '..', 'outside-secret.txt')
    await writeFile(outside, 'JWT_PRIVATE_KEY')
    try {
      await symlink(outside, join(root, 'bundle', 'outside.txt'))
      const violations = await scanTauriArtifacts(['bundle'], root)
      assert.ok(violations.some((violation) => violation.includes('outside artifact root')))
    } finally {
      await rm(outside, { force: true })
    }
  })
})

test('inspects compressed native artifacts and nested archives', async () => {
  await withFixture(async (root) => {
    const bundle = join(root, 'bundle')
    await writeFile(join(bundle, 'payload.js'), 'const key = "JWT_PRIVATE_KEY"\n')
    await execFileAsync('zip', ['-q', 'app.apk', 'payload.js'], { cwd: bundle })

    let violations = await scanTauriArtifacts([join('bundle', 'app.apk')], root)
    assert.equal(violations.length, 1)
    assert.match(violations[0], /app\.apk!\/payload\.js/)
    assert.match(violations[0], /JWT_PRIVATE_KEY/)

    const nested = join(bundle, 'nested')
    await writeFile(join(nested, 'payload.js'), 'const key = "AUTH_PEPPER"\n')
    await execFileAsync('zip', ['-q', join(bundle, 'inner.zip'), 'payload.js'], { cwd: nested })
    await execFileAsync('zip', ['-q', 'app.aab', 'inner.zip'], { cwd: bundle })

    violations = await scanTauriArtifacts([join('bundle', 'app.aab')], root)
    assert.ok(violations.some((violation) => violation.includes('AUTH_PEPPER')))
    assert.ok(violations.some((violation) => violation.includes('inner.zip!')))
  })
})

test('rejects symlink entries inside compressed native artifacts', async () => {
  await withFixture(async (root) => {
    const bundle = join(root, 'bundle')
    await writeFile(join(bundle, 'safe.js'), 'const safe = true\n')
    await symlink('safe.js', join(bundle, 'link.js'))
    await execFileAsync('zip', ['-q', '-y', 'app.apk', 'safe.js', 'link.js'], { cwd: bundle })

    const violations = await scanTauriArtifacts([join('bundle', 'app.apk')], root)
    assert.ok(violations.some((violation) => violation.includes('link.js')))
    assert.ok(violations.some((violation) => violation.includes('not a regular file or directory')))
  })
})

test('fails closed for archive formats outside the inspection allowlist', async () => {
  await withFixture(async (root) => {
    await writeFile(join(root, 'bundle', 'app.dmg'), 'safe-looking artifact\n')
    const violations = await scanTauriArtifacts(['bundle'], root)

    assert.equal(violations.length, 1)
    assert.match(violations[0], /unsupported archive format/)
    assert.match(violations[0], /app\.dmg/)
  })
})
