import assert from 'node:assert/strict'
import test from 'node:test'
import { hasSuccessfulVerifyRun, requireGitHubVerify } from './require-github-verify.mjs'

const sha = 'a'.repeat(40)

function run(overrides = {}) {
  return {
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

test('accepts only a successful exact-SHA main push of the reviewed workflow', () => {
  assert.equal(hasSuccessfulVerifyRun({ workflow_runs: [run()] }, sha), true)
  for (const overrides of [
    { head_sha: 'b'.repeat(40) },
    { path: '.github/workflows/other.yml' },
    { head_branch: 'feature' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
  ]) {
    assert.equal(hasSuccessfulVerifyRun({ workflow_runs: [run(overrides)] }, sha), false)
  }
})

test('queries the fixed workflow endpoint and does not expose API errors', async () => {
  const calls = []
  await assert.doesNotReject(() =>
    requireGitHubVerify(
      'kta/the-services-template',
      sha,
      'short-lived-token',
      async (input, init) => {
        calls.push({ input: new URL(input), init })
        return new Response(JSON.stringify({ workflow_runs: [run()] }), { status: 200 })
      },
    ),
  )
  assert.equal(
    calls[0].input.pathname,
    '/repos/kta/the-services-template/actions/workflows/ci.yml/runs',
  )
  assert.equal(calls[0].input.searchParams.get('head_sha'), sha)
  assert.equal(calls[0].input.searchParams.get('event'), 'push')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers.authorization, 'Bearer short-lived-token')
  await assert.rejects(
    () =>
      requireGitHubVerify(
        'kta/the-services-template',
        sha,
        'short-lived-token',
        async () => new Response('private details', { status: 403 }),
      ),
    /lookup failed/,
  )
})
