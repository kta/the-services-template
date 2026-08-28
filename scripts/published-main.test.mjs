import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshPublishedMain } from './published-main.mjs'

const mainSha = '0123456789abcdef0123456789abcdef01234567'

test('resolves the canonical protected main SHA outside repository-local git config', () => {
  const calls = []
  const result = refreshPublishedMain({ GITHUB_ACTIONS: 'true' }, (_binary, args, options) => {
    calls.push({ args, options })
    if (args[0] === 'config') return 'https://github.com/kta/the-services-template.git\n'
    return `${mainSha}  refs/heads/main\n`
  })
  assert.equal(result, mainSha)
  assert.equal(calls[1].args[0], 'ls-remote')
  assert.match(calls[1].options.cwd, /published-main-/)
  assert.equal(calls[1].options.env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(calls[1].options.env.GIT_SSH_COMMAND, 'false')
})

test('rejects a non-canonical origin and malformed main response', () => {
  assert.throws(
    () =>
      refreshPublishedMain({}, (_binary, args) => {
        if (args[0] === 'config') return 'https://example.invalid/mirror.git\n'
        return `${mainSha}  refs/heads/main\n`
      }),
    /canonical GitHub repository/,
  )
  assert.throws(
    () =>
      refreshPublishedMain({}, (_binary, args) => {
        if (args[0] === 'config') return 'https://github.com/kta/the-services-template.git\n'
        return 'not-a-sha refs/heads/main\n'
      }),
    /valid main SHA/,
  )
})
