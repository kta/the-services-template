import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const githubEnvironment = {
  ...process.env,
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REF: 'refs/pull/42/merge',
  GITHUB_REF_PROTECTED: 'false',
  GITHUB_REPOSITORY: 'acme/services',
  GITHUB_WORKFLOW_REF: 'acme/services/.github/workflows/ci.yml@refs/heads/feature',
  GITHUB_RUN_ID: '42',
  GITHUB_WORKSPACE: root,
}

test('native package scripts put the runtime guard before every package build entry', async () => {
  for (const directory of ['admin', 'example_tauri_service']) {
    const packageJson = JSON.parse(
      await readFile(join(root, 'services', directory, 'package.json'), 'utf8'),
    )
    assert.match(
      packageJson.scripts['build:tauri'],
      /^node \.\.\/\.\.\/scripts\/native-workflow\.mjs package-guard && /,
    )
    assert.match(
      packageJson.scripts.tauri,
      /^node \.\.\/\.\.\/scripts\/native-workflow\.mjs package-guard && /,
    )
  }
})

test('CI package dispatch variations cannot bypass the runtime package-build capability', async () => {
  const fixtures = [
    {
      name: 'split package selector',
      cwd: root,
      command: 'pnpm --filter "$SCOPE/$SERVICE" run build:tauri',
      env: { SCOPE: '@app', SERVICE: 'admin' },
    },
    {
      name: 'split script name',
      cwd: root,
      command: 'pnpm --filter @app/admin run "$SCRIPT_PREFIX:$SCRIPT_SUFFIX"',
      env: { SCRIPT_PREFIX: 'build', SCRIPT_SUFFIX: 'tauri' },
    },
    {
      name: 'GitHub format expression result',
      cwd: root,
      command: 'pnpm --filter @app/admin run "$FORMATTED_SCRIPT" -- build --debug',
      env: { FORMATTED_SCRIPT: 'tauri' },
    },
    {
      name: 'package cwd change',
      cwd: join(root, 'services/admin'),
      command: 'pnpm run build:tauri',
      env: {},
    },
  ]

  for (const fixture of fixtures) {
    await assert.rejects(
      execFileAsync('/bin/sh', ['-c', fixture.command], {
        cwd: fixture.cwd,
        env: { ...githubEnvironment, ...fixture.env },
      }),
      (error) => {
        assert.match(
          `${error.stdout}\n${error.stderr}`,
          /native workflow package-build capability|registered manual protected-main native executor/i,
          fixture.name,
        )
        return true
      },
      fixture.name,
    )
  }
})
