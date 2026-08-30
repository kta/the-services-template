import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = process.cwd()

test('native selector returns the validated catalog package identity', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    join(root, 'scripts/service-catalog.mjs'),
    'native-selector',
    'admin',
  ])
  assert.equal(stdout, '@app/admin\n')
})

test('native Make targets do not execute shell metacharacters from the stem', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'native-make-injection-'))
  const marker = join(fixture, 'executed')
  const command = join(fixture, 'catalog_injection_marker')
  await writeFile(command, `#!/bin/sh\nprintf executed > '${marker}'\n`)
  await chmod(command, 0o700)
  try {
    await assert.rejects(
      execFileAsync('make', ['build/missing;catalog_injection_marker/tauri'], {
        cwd: root,
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}` },
      }),
    )
    await assert.rejects(readFile(marker, 'utf8'))
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('native Make recipes delegate package selection and pnpm argv to the runner', async () => {
  const makefile = await readFile(join(root, 'Makefile'), 'utf8')
  assert.match(makefile, /run-native-service\.mjs dev/)
  assert.match(makefile, /run-native-service\.mjs build/)
  assert.doesNotMatch(makefile, /(?:dev|build)\/%\/tauri:[\s\S]*?pnpm --filter @app\/\$\*/)
})
