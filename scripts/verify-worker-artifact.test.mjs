import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildWorkerArtifactManifest,
  installVerifiedWorkerArtifact,
  validateArchiveEntries,
  verifyWorkerArtifact,
  writeWorkerArtifactManifest,
} from './verify-worker-artifact.mjs'

const SERVICES = ['admin', 'notifier', 'ops']

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'worker-artifact-test-'))
  for (const service of SERVICES) {
    const dist = join(root, 'services', service, 'dist')
    mkdirSync(dist, { recursive: true })
    const outputDirectory = service === 'notifier' || service === 'ops' ? dist : join(dist, service)
    mkdirSync(outputDirectory, { recursive: true })
    writeFileSync(join(outputDirectory, 'index.js'), `export const service = '${service}'\n`)
    if (service === 'admin') {
      mkdirSync(join(dist, 'client'), { recursive: true })
      writeFileSync(join(dist, 'client', 'index.html'), '<!doctype html>\n')
    }
  }
  return root
}

function createArchive(root, archivePath, extra = []) {
  const manifestPath = join(root, 'production-worker-manifest.json')
  const manifest = buildWorkerArtifactManifest(root, SERVICES)
  writeFileSync(manifestPath, JSON.stringify(manifest))
  execFileSync(
    'tar',
    [
      '--create',
      '--gzip',
      `--file=${archivePath}`,
      '--',
      'production-worker-manifest.json',
      ...SERVICES.map((service) => `services/${service}/dist`),
      ...extra,
    ],
    { cwd: root },
  )
}

test('worker manifest binds every regular output file to its size and SHA-256', () => {
  const root = fixtureRoot()
  try {
    const manifest = buildWorkerArtifactManifest(root, SERVICES)
    assert.deepEqual(manifest.services, SERVICES)
    assert.ok(manifest.files.some((entry) => entry.path === 'services/admin/dist/admin/index.js'))
    assert.ok(manifest.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('binds a CI artifact manifest to the exact repository commit and workflow run', () => {
  const root = fixtureRoot()
  const names = ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_WORKFLOW_REF', 'GITHUB_RUN_ID']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    process.env.GITHUB_REPOSITORY = 'kta/the-services-template'
    process.env.GITHUB_SHA = 'a'.repeat(40)
    process.env.GITHUB_WORKFLOW_REF =
      'kta/the-services-template/.github/workflows/ci.yml@refs/heads/main'
    process.env.GITHUB_RUN_ID = '12345'
    const manifest = buildWorkerArtifactManifest(root, SERVICES)
    assert.deepEqual(manifest.provenance, {
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      runId: process.env.GITHUB_RUN_ID,
    })
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('does not read a manifest outside the workspace', () => {
  const root = fixtureRoot()
  try {
    assert.throws(
      () => verifyWorkerArtifact(root, SERVICES, '../outside/production-worker-manifest.json'),
      /manifest path escapes the workspace/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects symlinks and private-key markers in Worker output', () => {
  const root = fixtureRoot()
  try {
    symlinkSync('/etc/passwd', join(root, 'services', 'admin', 'dist', 'escaped'))
    assert.throws(
      () => buildWorkerArtifactManifest(root, SERVICES),
      /symbolic links are not allowed/,
    )
    rmSync(join(root, 'services', 'admin', 'dist', 'escaped'))
    writeFileSync(
      join(root, 'services', 'admin', 'dist', 'admin', 'private.js'),
      `${['-----BEGIN ', 'PRIVATE KEY-----'].join('')}\nsecret\n`,
    )
    assert.throws(
      () => buildWorkerArtifactManifest(root, SERVICES),
      /secret marker .*PRIVATE KEY.*not allowed/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('allows runtime Worker binding names but rejects an inlined secret value', () => {
  const root = fixtureRoot()
  try {
    writeFileSync(
      join(root, 'services', 'ops', 'dist', 'private.js'),
      'const names = { R2_POLICY_CHECK_API_TOKEN: env.R2_POLICY_CHECK_API_TOKEN, BACKUP_SIGNING_PRIVATE_KEY: env.BACKUP_SIGNING_PRIVATE_KEY }\n',
    )
    assert.doesNotThrow(() => buildWorkerArtifactManifest(root, SERVICES))
    writeFileSync(
      join(root, 'services', 'ops', 'dist', 'private.js'),
      'const value = { R2_POLICY_CHECK_API_TOKEN: "opaque-production-secret-value-0123456789" }\n',
    )
    assert.throws(
      () => buildWorkerArtifactManifest(root, SERVICES),
      /secret marker R2_POLICY_CHECK_API_TOKEN is not allowed/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects published development fixture values in Worker output', () => {
  const root = fixtureRoot()
  try {
    writeFileSync(
      join(root, 'services', 'admin', 'dist', 'admin', 'fixture.js'),
      'const pepper = "dev-auth-pepper-change-me"\n',
    )
    assert.throws(
      () => buildWorkerArtifactManifest(root, SERVICES),
      /secret marker dev-auth-pepper-change-me is not allowed/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a symlinked Worker artifact parent before recursive collection', () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-artifact-parent-'))
  const outside = mkdtempSync(join(tmpdir(), 'worker-artifact-parent-outside-'))
  try {
    mkdirSync(join(outside, 'admin', 'dist', 'admin'), { recursive: true })
    mkdirSync(join(outside, 'admin', 'dist', 'client'), { recursive: true })
    writeFileSync(join(outside, 'admin', 'dist', 'admin', 'index.js'), 'export {}\n')
    writeFileSync(join(outside, 'admin', 'dist', 'client', 'index.html'), '<!doctype html>\n')
    mkdirSync(join(root, 'services'), { recursive: true })
    symlinkSync(join(outside, 'admin'), join(root, 'services', 'admin'))
    assert.throws(
      () => buildWorkerArtifactManifest(root, ['admin']),
      /cannot traverse a symbolic link/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('does not write manifests through symlinked paths', () => {
  const root = fixtureRoot()
  const outside = mkdtempSync(join(tmpdir(), 'worker-artifact-outside-'))
  try {
    symlinkSync(outside, join(root, 'manifest-link'))
    assert.throws(
      () => writeWorkerArtifactManifest(root, SERVICES, 'manifest-link/manifest.json'),
      /symbolic link/,
    )
    symlinkSync(join(outside, 'manifest.json'), join(root, 'production-worker-manifest.json'))
    assert.throws(() => writeWorkerArtifactManifest(root, SERVICES), /symbolic link|regular file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('does not install an archive through a symlinked service directory', () => {
  const source = fixtureRoot()
  const destination = mkdtempSync(join(tmpdir(), 'worker-artifact-destination-'))
  const outside = mkdtempSync(join(tmpdir(), 'worker-artifact-outside-'))
  const archive = join(source, 'worker-bundles.tar.gz')
  try {
    createArchive(source, archive)
    mkdirSync(join(destination, 'services'), { recursive: true })
    symlinkSync(outside, join(destination, 'services', 'admin'))
    assert.throws(
      () =>
        installVerifiedWorkerArtifact({
          archivePath: archive,
          workspaceRoot: destination,
          services: SERVICES,
        }),
      /symbolic link/,
    )
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(destination, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('rejects unsafe, duplicate, symlink, and non-regular archive entries', () => {
  assert.throws(
    () =>
      validateArchiveEntries(
        ['production-worker-manifest.json', 'services/admin/dist/../secret'],
        ['-rw-r--r-- production-worker-manifest.json', '-rw-r--r-- services/admin/dist/../secret'],
        SERVICES,
      ),
    /unsafe archive path/,
  )
  assert.throws(
    () =>
      validateArchiveEntries(
        ['production-worker-manifest.json', 'production-worker-manifest.json'],
        [
          '-rw-r--r-- production-worker-manifest.json',
          '-rw-r--r-- production-worker-manifest.json',
        ],
        SERVICES,
      ),
    /duplicate archive entry/,
  )
  assert.throws(
    () =>
      validateArchiveEntries(
        ['production-worker-manifest.json', 'services/admin/dist/escaped'],
        [
          '-rw-r--r-- production-worker-manifest.json',
          'lrwxrwxrwx services/admin/dist/escaped -> /etc/passwd',
        ],
        SERVICES,
      ),
    /non-regular archive entry/,
  )
})

test('extracts and installs only a verified Worker archive', () => {
  const source = fixtureRoot()
  const destination = mkdtempSync(join(tmpdir(), 'worker-artifact-destination-'))
  const archive = join(source, 'worker-bundles.tar.gz')
  try {
    createArchive(source, archive)
    installVerifiedWorkerArtifact({
      archivePath: archive,
      workspaceRoot: destination,
      services: SERVICES,
    })
    assert.equal(
      buildWorkerArtifactManifest(destination, SERVICES).files.length,
      buildWorkerArtifactManifest(source, SERVICES).files.length,
    )
    writeFileSync(join(destination, 'services', 'admin', 'dist', 'admin', 'index.js'), 'tampered')
    assert.throws(
      () => verifyWorkerArtifact(destination, SERVICES),
      /does not match the reviewed manifest|manifest is missing/,
    )
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(destination, { recursive: true, force: true })
  }
})
