import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const guard = fileURLToPath(new URL('./require-production-bootstrap.mjs', import.meta.url))

import {
  isProtectedMainWorkflowDispatch,
  requireProtectedMainWorkflowDispatch,
} from './require-production-bootstrap.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'production-bootstrap-'))
  const remote = mkdtempSync(join(tmpdir(), 'production-bootstrap-remote-'))
  git(cwd, 'init', '-b', 'main')
  git(remote, 'init', '--bare')
  git(cwd, 'config', 'protocol.file.allow', 'always')
  git(cwd, 'config', 'user.email', 'test@example.com')
  git(cwd, 'config', 'user.name', 'test')
  writeFileSync(join(cwd, 'tracked.txt'), 'tracked')
  git(cwd, 'add', 'tracked.txt')
  git(cwd, 'commit', '-m', 'fixture')
  git(cwd, 'remote', 'add', 'origin', 'https://github.com/kta/the-services-template.git')
  git(
    cwd,
    'config',
    `url.file://${remote}.insteadOf`,
    'https://github.com/kta/the-services-template.git',
  )
  git(cwd, 'push', '-q', 'origin', 'main')
  const sha = git(cwd, 'rev-parse', 'HEAD')
  return { cwd, remote, sha }
}

test('accepts only a protected main workflow dispatch', () => {
  assert.equal(
    isProtectedMainWorkflowDispatch({
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      PRODUCTION_ENVIRONMENT: 'production',
    }),
    true,
  )
  for (const change of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REF_PROTECTED: 'false' },
    { GITHUB_ACTIONS: 'false' },
  ]) {
    assert.equal(
      isProtectedMainWorkflowDispatch({
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_PROTECTED: 'true',
        PRODUCTION_ENVIRONMENT: 'production',
        ...change,
      }),
      false,
    )
  }
})

test('accepts a clean published main checkout without minting an OIDC token', () => {
  const { cwd, remote, sha } = fixture()
  try {
    assert.equal(
      requireProtectedMainWorkflowDispatch(
        {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REF_PROTECTED: 'true',
          GITHUB_SHA: sha,
          GITHUB_REPOSITORY: 'kta/the-services-template',
          PRODUCTION_ENVIRONMENT: 'production',
        },
        () => sha,
        (binary, args, options) => execFileSync(binary, args, { ...options, cwd }),
      ),
      true,
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('rejects a feature branch even when workflow variables claim protected main', () => {
  const { cwd, remote, sha } = fixture()
  try {
    git(cwd, 'checkout', '-b', 'feature')
    assert.throws(
      () =>
        execFileSync(process.execPath, [guard], {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_ACTIONS: 'true',
            GITHUB_EVENT_NAME: 'workflow_dispatch',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REF_PROTECTED: 'true',
            GITHUB_SHA: sha,
            GITHUB_REPOSITORY: 'kta/the-services-template',
            PRODUCTION_ENVIRONMENT: 'production',
          },
        }),
      /bootstrap requires the checked-out main branch/,
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('rejects a main commit that is not the fetched origin/main commit', () => {
  const { cwd, remote, sha } = fixture()
  try {
    writeFileSync(join(cwd, 'unpublished.txt'), 'not published')
    git(cwd, 'add', 'unpublished.txt')
    git(cwd, 'commit', '-m', 'unpublished')
    assert.throws(
      () =>
        execFileSync(process.execPath, [guard], {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_ACTIONS: 'true',
            GITHUB_EVENT_NAME: 'workflow_dispatch',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REF_PROTECTED: 'true',
            GITHUB_SHA: sha,
            GITHUB_REPOSITORY: 'kta/the-services-template',
            PRODUCTION_ENVIRONMENT: 'production',
          },
        }),
      /current main checkout has uncommitted|checked-out commit|HEAD to match the fetched origin\/main/,
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})
