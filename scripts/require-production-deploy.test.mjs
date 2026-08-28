import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('./require-production-deploy.mjs', import.meta.url))

import { requireProtectedMainPush } from './require-production-deploy.mjs'

const fixture = mkdtempSync(join(tmpdir(), 'production-deploy-guard-'))
const remote = mkdtempSync(join(tmpdir(), 'production-deploy-remote-'))
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture })
execFileSync('git', ['init', '--bare', '-q', remote])
execFileSync('git', ['config', 'protocol.file.allow', 'always'], { cwd: fixture })
execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: fixture })
execFileSync('git', ['config', 'user.name', 'test'], { cwd: fixture })
writeFileSync(join(fixture, 'tracked.txt'), 'fixture\n')
execFileSync('git', ['add', 'tracked.txt'], { cwd: fixture })
execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: fixture })
execFileSync(
  'git',
  ['remote', 'add', 'origin', 'https://github.com/kta/the-services-template.git'],
  {
    cwd: fixture,
  },
)
execFileSync(
  'git',
  ['config', `url.file://${remote}.insteadOf`, 'https://github.com/kta/the-services-template.git'],
  { cwd: fixture },
)
execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: fixture })
const fixtureSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: fixture,
  encoding: 'utf8',
}).trim()
execFileSync('git', ['update-ref', 'refs/remotes/origin/main', fixtureSha], { cwd: fixture })

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function run(envOverrides, cwd = process.cwd()) {
  const env = { ...process.env, ...envOverrides }
  return spawnSync(process.execPath, [guard], { cwd, env, encoding: 'utf8' })
}

test.after(() => {
  rmSync(fixture, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
})

test('accepts only the protected main push checkout and commit', () => {
  assert.equal(
    requireProtectedMainPush(
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_PROTECTED: 'true',
        GITHUB_SHA: fixtureSha,
        GITHUB_REPOSITORY: 'kta/the-services-template',
      },
      () => fixtureSha,
      (binary, args, options) => execFileSync(binary, args, { ...options, cwd: fixture }),
    ),
    true,
  )
})

test('does not trust a caller-provided allow marker for another ref or event', () => {
  const result = run({
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/feature',
    GITHUB_REF_PROTECTED: 'false',
    PRODUCTION_DEPLOY_ALLOWED: 'true',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /protected main/)
})

test('does not trust forged GitHub variables when the actual checkout is a feature branch', () => {
  execFileSync('git', ['switch', '-q', '-c', 'feature'], { cwd: fixture })
  const result = run(
    {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: fixtureSha,
      PRODUCTION_DEPLOY_ALLOWED: 'true',
    },
    fixture,
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /checked-out main branch/)
})

test('does not allow a clean but locally modified main commit to deploy', () => {
  execFileSync('git', ['switch', '-q', 'main'], { cwd: fixture })
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', fixtureSha], { cwd: fixture })
  writeFileSync(join(fixture, 'tracked.txt'), 'unreviewed local change\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: fixture })
  execFileSync('git', ['commit', '-q', '-m', 'unreviewed local change'], { cwd: fixture })
  const currentSha = git(fixture, 'rev-parse', 'HEAD')
  assert.throws(
    () =>
      requireProtectedMainPush(
        {
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REF_PROTECTED: 'true',
          GITHUB_SHA: currentSha,
          GITHUB_REPOSITORY: 'kta/the-services-template',
        },
        () => fixtureSha,
        (binary, args, options) => execFileSync(binary, args, { ...options, cwd: fixture }),
      ),
    /freshly fetched origin\/main commit/,
  )
})

test('does not let forged GitHub variables bypass the fetched main commit check', () => {
  execFileSync('git', ['switch', '-q', 'main'], { cwd: fixture })
  const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture,
    encoding: 'utf8',
  }).trim()
  const unpublishedSha = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD'], {
    cwd: fixture,
    input: 'unpublished\n',
    encoding: 'utf8',
  }).trim()
  execFileSync('git', ['update-ref', 'refs/heads/main', unpublishedSha], { cwd: fixture })
  const result = run(
    {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: unpublishedSha,
      GITHUB_REPOSITORY: 'kta/the-services-template',
    },
    fixture,
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /fetched origin\/main commit/)
  execFileSync('git', ['update-ref', 'refs/heads/main', currentSha], { cwd: fixture })
})

for (const [name, value] of [
  ['E2E_AUTH', 'true'],
  ['AUTH_DEV_GRANT', 'true'],
  ['AUTH_DEV_PRIVATE_KEY', 'test-only-key'],
]) {
  test(`rejects ${name} during a production deploy`, () => {
    const result = run({
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      [name]: value,
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /development authentication/)
  })
}
