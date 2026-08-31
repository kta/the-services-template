import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { inspectNativePackageBuildPlan } from './native-package-build-policy.mjs'
import {
  assertNativeWorkflowExecutorContext,
  executeNativePackageBuildPlan,
  nativePackageBuildPlan,
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

test('derives the native package build as the exact reviewed command plan', () => {
  assert.deepEqual(nativePackageBuildPlan(root, service, { nodePath: '/reviewed/bin/node' }), [
    {
      command: '/reviewed/bin/node',
      args: [
        join(root, 'scripts/run-without-cloudflare-env.mjs'),
        'pnpm',
        'exec',
        'vite',
        '--config',
        'vite.tauri.config.ts',
        'build',
      ],
      cwd: join(root, 'services/booking'),
    },
    {
      command: '/reviewed/bin/node',
      args: [join(root, 'scripts/clean-build-secrets.mjs'), 'dist'],
      cwd: join(root, 'services/booking'),
    },
    {
      command: '/reviewed/bin/node',
      args: [join(root, 'scripts/check-tauri-artifact.mjs'), 'dist/tauri'],
      cwd: join(root, 'services/booking'),
    },
  ])
})

test('executes the native package plan in order with the artifact scan last exactly once', async () => {
  const plan = nativePackageBuildPlan(root, service, { nodePath: '/reviewed/bin/node' })
  const calls = []
  await executeNativePackageBuildPlan(plan, async (command, args, cwd) => {
    calls.push({ command, args, cwd })
  })

  assert.deepEqual(calls, plan)
  assert.equal(
    calls.filter(({ args }) => args[0] === join(root, 'scripts/check-tauri-artifact.mjs')).length,
    1,
  )
  assert.equal(calls.at(-1).args[0], join(root, 'scripts/check-tauri-artifact.mjs'))
})

test('stops the native package plan at the first executor failure', async () => {
  const plan = nativePackageBuildPlan(root, service, { nodePath: '/reviewed/bin/node' })
  const calls = []
  await assert.rejects(
    executeNativePackageBuildPlan(plan, async (command, args, cwd) => {
      calls.push({ command, args, cwd })
      if (calls.length === 2) throw new Error('cleanup failed')
    }),
    /cleanup failed/,
  )
  assert.deepEqual(calls, plan.slice(0, 2))
})

test('rejects native package plans with a removed, reordered, or additional command', () => {
  const nodePath = '/reviewed/bin/node'
  const plan = nativePackageBuildPlan(root, service, { nodePath })
  assert.deepEqual(inspectNativePackageBuildPlan(plan, root, service, nodePath), [])

  const reordered = [plan[1], plan[0], plan[2]]
  const additional = [
    ...plan,
    { command: nodePath, args: ['fallback-native-build'], cwd: join(root, 'services/booking') },
  ]
  for (const invalid of [plan.slice(0, 2), reordered, additional]) {
    assert.match(
      inspectNativePackageBuildPlan(invalid, root, service, nodePath).join('\n'),
      /exactly execute Vite build, secret cleanup, and artifact scan in order/i,
    )
  }
})

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
  assert.deepEqual(nativeWorkflowInvocation(root, service, 'check-release', tools), {
    command: '/reviewed/node/bin/node',
    args: [join(root, 'scripts/check-native-release.mjs'), 'booking'],
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
      /defense-in-depth context check.*manual protected-main/i,
      name,
    )
  }
})

test('registered wrapper passes a bounded defense-in-depth capability to exact package entries', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'native-workflow-capability-'))
  const runtimeRoot = join(fixture, 'runtime')
  const secureNode = join(runtimeRoot, 'bin', 'node')
  const fakePnpm = join(fixture, 'pnpm')
  const marker = join(fixture, 'guard-ran')
  const { stdout: reviewedPnpm } = await execFileAsync('/usr/bin/which', ['pnpm'])
  await writeFile(
    fakePnpm,
    `#!${secureNode}
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const workspace = ${JSON.stringify(process.cwd())}
const reviewedPnpm = ${JSON.stringify(reviewedPnpm.trim())}
const args = process.argv.slice(2)
const wrapper = join(workspace, 'scripts/native-workflow.mjs')
process.chdir(join(workspace, 'services/admin'))

if (args[0] === '--filter' && args[1] === '@app/admin' && args[2] === 'run' && args[3] === 'tauri') {
  execFileSync(process.execPath, [wrapper, 'package', 'tauri', ...args.slice(4)], { stdio: 'inherit' })
  try {
    execFileSync(process.execPath, [wrapper, 'package', 'tauri', 'info'], { stdio: 'ignore' })
    process.exit(92)
  } catch {}
} else if (args[0] === 'exec' && args[1] === 'tauri' && args[2] === 'build') {
  execFileSync(process.execPath, [wrapper, 'package', 'build'], { stdio: 'inherit' })
  try {
    execFileSync(process.execPath, [wrapper, 'package', 'build'], { stdio: 'ignore' })
    process.exit(91)
  } catch {}
} else if (args[0] === 'exec' && args[1] === 'tauri') {
  // The fake CLI intentionally performs no native work.
} else if (args[0] === 'exec' && args[1] === 'vite') {
  execFileSync(reviewedPnpm, args, { stdio: 'inherit' })
} else {
  process.exit(93)
}
writeFileSync(${JSON.stringify(marker)}, 'guarded')
`,
  )
  await cp(dirname(dirname(process.execPath)), runtimeRoot, { recursive: true })
  await chmod(join(runtimeRoot, 'bin'), 0o700)
  await chmod(secureNode, 0o500)
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
        secureNode,
        [join(process.cwd(), 'scripts/native-workflow.mjs'), 'admin', action],
        { cwd: process.cwd(), env: github },
      )
    }
    assert.equal(await readFile(marker, 'utf8'), 'guarded')

    await assert.rejects(
      execFileAsync(
        secureNode,
        [join(process.cwd(), 'scripts/native-workflow.mjs'), 'package', 'tauri', 'info'],
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
