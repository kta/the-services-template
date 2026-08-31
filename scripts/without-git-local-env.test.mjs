import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('removes outer Git repository-local variables from fixture commands', async () => {
  const wrapper = join(process.cwd(), 'scripts/without-git-local-env.mjs')
  const variables = [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_WORK_TREE',
  ]
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      wrapper,
      process.execPath,
      '-e',
      `process.stdout.write(JSON.stringify(${JSON.stringify(variables)}.filter((name) => process.env[name] !== undefined)))`,
    ],
    {
      env: Object.fromEntries([
        ...Object.entries(process.env),
        ...variables.map((name) => [name, '/outer/repository']),
      ]),
    },
  )
  assert.equal(stdout, '[]')
})
