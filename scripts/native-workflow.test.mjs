import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  assertNativeWorkflowExecutorContext,
  nativeWorkflowChildEnvironment,
  nativeWorkflowInvocation,
} from './native-workflow.mjs'

const execFileAsync = promisify(execFile)

const root = '/workspace'
const service = {
  directory: 'booking',
  package: '@app/booking',
  native: true,
  nativeWorkflow: '.github/workflows/booking-tauri-build.yml',
}

const validGithubContext = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_PROTECTED: 'true',
  GITHUB_REPOSITORY: 'acme/services',
  GITHUB_WORKFLOW_REF: 'acme/services/.github/workflows/booking-tauri-build.yml@refs/heads/main',
  GITHUB_RUN_ID: '123456',
  GITHUB_WORKSPACE: root,
}

test('derives native build and verifier argv only from normalized catalog identity', () => {
  const tools = { nodePath: '/reviewed/node/bin/node', pnpmPath: '/reviewed/pnpm/bin/pnpm' }
  assert.deepEqual(nativeWorkflowInvocation(root, service, 'build-macos', tools), {
    command: '/reviewed/pnpm/bin/pnpm',
    args: [
      '--filter',
      '@app/booking',
      'run',
      'tauri',
      'build',
      '--debug',
      '--bundles',
      'app',
      '--target',
      'universal-apple-darwin',
      '--no-sign',
    ],
    cwd: root,
  })
  assert.deepEqual(nativeWorkflowInvocation(root, service, 'verify-android-apk', tools), {
    command: '/reviewed/node/bin/node',
    args: [
      join(root, 'scripts/check-tauri-artifact.mjs'),
      join(root, 'services/booking/src-tauri/gen/android/app/build/outputs/apk'),
    ],
    cwd: root,
  })
})

test('rebuilds the native child environment without Node or package-manager injection', () => {
  assert.deepEqual(
    nativeWorkflowChildEnvironment(
      {
        HOME: '/runner',
        CARGO_HOME: '/runner/.cargo',
        RUSTUP_HOME: '/runner/.rustup',
        ANDROID_HOME: '/opt/android',
        JAVA_HOME: '/opt/java',
        ANDROID_PLATFORM_API: '35',
        ANDROID_NDK_VERSION: '27.2.12479018',
        XCODEGEN_VERSION: '2.46.0',
        PATH: './rogue-bin',
        NODE_OPTIONS: '--require=./rogue.cjs',
        NODE_PATH: './rogue-modules',
        PNPM_HOME: './rogue-pnpm',
      },
      { nodePath: '/reviewed/node/bin/node', pnpmPath: '/reviewed/pnpm/bin/pnpm' },
    ),
    {
      HOME: '/runner',
      CARGO_HOME: '/runner/.cargo',
      RUSTUP_HOME: '/runner/.rustup',
      ANDROID_HOME: '/opt/android',
      NDK_HOME: '/opt/android/ndk/27.2.12479018',
      JAVA_HOME: '/opt/java',
      ANDROID_PLATFORM_API: '35',
      ANDROID_NDK_VERSION: '27.2.12479018',
      XCODEGEN_VERSION: '2.46.0',
      PATH: '/reviewed/node/bin:/reviewed/pnpm/bin:/runner/.cargo/bin:/opt/android/platform-tools:/opt/android/cmdline-tools/latest/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    },
  )
})

test('rejects unknown actions and identities before forming a filesystem path or package selector', () => {
  assert.throws(
    () => nativeWorkflowInvocation(root, service, 'build-rogue'),
    /unknown native workflow action/i,
  )
  assert.throws(
    () =>
      nativeWorkflowInvocation(
        root,
        { directory: '../rogue', package: '@app/booking', native: true },
        'boundary',
      ),
    /normalized catalog identity/i,
  )
  assert.throws(
    () =>
      nativeWorkflowInvocation(
        root,
        { directory: 'booking', package: '@app/rogue', native: true },
        'boundary',
      ),
    /normalized catalog identity/i,
  )
})

test('requires the catalog manual protected-main executor context in GitHub Actions', () => {
  assert.doesNotThrow(() => assertNativeWorkflowExecutorContext(root, service, validGithubContext))
  assert.doesNotThrow(() =>
    assertNativeWorkflowExecutorContext(root, service, { GITHUB_ACTIONS: 'false' }),
  )

  for (const [name, value] of [
    ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_REF', 'refs/heads/feature'],
    ['GITHUB_REF_PROTECTED', 'false'],
    ['GITHUB_WORKFLOW_REF', 'acme/services/.github/workflows/ci.yml@refs/heads/main'],
    ['GITHUB_RUN_ID', 'not-a-run'],
    ['GITHUB_WORKSPACE', '/different/workspace'],
  ]) {
    assert.throws(
      () =>
        assertNativeWorkflowExecutorContext(root, service, {
          ...validGithubContext,
          [name]: value,
        }),
      /registered manual protected-main native executor/i,
      name,
    )
  }
})

test('registered wrapper issues a bounded package-build capability in the same executor', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'native-workflow-capability-'))
  const fakePnpm = join(fixture, 'pnpm')
  const marker = join(fixture, 'guard-ran')
  await writeFile(
    fakePnpm,
    `#!/bin/sh
set -eu
cd "$GITHUB_WORKSPACE/services/admin"
node ../../scripts/native-workflow.mjs package-guard
case " $* " in
  *" build "*)
    node ../../scripts/native-workflow.mjs package-guard
    if node ../../scripts/native-workflow.mjs package-guard 2>/dev/null; then exit 91; fi
    ;;
  *)
    if node ../../scripts/native-workflow.mjs package-guard 2>/dev/null; then exit 92; fi
    ;;
esac
printf guarded > "$RUNNER_TEMP/guard-ran"
`,
  )
  await chmod(fakePnpm, 0o700)
  const github = {
    ...validGithubContext,
    GITHUB_WORKSPACE: process.cwd(),
    GITHUB_WORKFLOW_REF: 'acme/services/.github/workflows/tauri-build.yml@refs/heads/main',
    RUNNER_TEMP: fixture,
    PATH: `${fixture}${delimiter}${process.env.PATH}`,
  }
  try {
    for (const action of ['build-macos', 'init-ios', 'init-android']) {
      await execFileAsync(
        process.execPath,
        [join(process.cwd(), 'scripts/native-workflow.mjs'), 'admin', action],
        { cwd: process.cwd(), env: github },
      )
    }
    assert.equal(await readFile(marker, 'utf8'), 'guarded')

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [join(process.cwd(), 'scripts/native-workflow.mjs'), 'package-guard'],
        { cwd: join(process.cwd(), 'services/admin'), env: github },
      ),
      (error) => {
        assert.match(error.stderr, /native workflow package-build capability/i)
        return true
      },
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
