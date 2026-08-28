import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { requireProtectedProductionWorkflow } from './require-production-provisioning.mjs'

const guard = fileURLToPath(new URL('./require-production-provisioning.mjs', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'production-provisioning-guard-'))
const remote = mkdtempSync(join(tmpdir(), 'production-provisioning-remote-'))
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

const protectedWorkflowEnvironment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_PROTECTED: 'true',
  GITHUB_REPOSITORY: 'kta/the-services-template',
  GITHUB_SHA: fixtureSha,
  PRODUCTION_ENVIRONMENT: 'production',
}

function run(envOverrides, cwd = fixture) {
  return spawnSync(process.execPath, [guard], {
    cwd,
    env: { ...process.env, ...protectedWorkflowEnvironment, ...envOverrides },
    encoding: 'utf8',
  })
}

function runProtected(envOverrides = {}, refresh = () => fixtureSha) {
  return requireProtectedProductionWorkflow(
    { ...protectedWorkflowEnvironment, ...envOverrides },
    refresh,
    (binary, args, options) => execFileSync(binary, args, { ...options, cwd: fixture }),
  )
}

test.after(() => {
  rmSync(fixture, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
})

test('rejects a clean local main because production writes require a protected workflow', () => {
  const result = run({ GITHUB_ACTIONS: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /protected production workflow/)
})

test('accepts a clean checked-out main only inside the protected production workflow', () => {
  assert.equal(runProtected(), true)
})

test('rejects a feature branch even when the checkout is clean', () => {
  execFileSync('git', ['switch', '-q', '-c', 'feature'], { cwd: fixture })
  assert.throws(() => runProtected(), /checked-out main branch/)
  execFileSync('git', ['switch', '-q', 'main'], { cwd: fixture })
})

test('rejects uncommitted provisioning input', () => {
  writeFileSync(join(fixture, 'untracked.txt'), 'must not be provisioned\n')
  assert.throws(() => runProtected(), /uncommitted or untracked/)
  rmSync(join(fixture, 'untracked.txt'))
})

test('rejects a main commit that is not the freshly resolved published main', () => {
  const unpublishedSha = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD'], {
    cwd: fixture,
    input: 'unpublished\n',
    encoding: 'utf8',
  }).trim()
  execFileSync('git', ['update-ref', 'refs/heads/main', unpublishedSha], { cwd: fixture })
  assert.throws(() => runProtected(), /fetched origin\/main commit/)
  execFileSync('git', ['update-ref', 'refs/heads/main', fixtureSha], { cwd: fixture })
})
