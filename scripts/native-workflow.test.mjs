import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { nativeWorkflowChildEnvironment, nativeWorkflowInvocation } from './native-workflow.mjs'

const root = '/workspace'
const service = {
  directory: 'booking',
  package: '@app/booking',
  native: true,
}

test('derives native build and verifier argv only from normalized catalog identity', () => {
  const tools = { nodePath: '/reviewed/node/bin/node', pnpmPath: '/reviewed/pnpm/bin/pnpm' }
  assert.deepEqual(nativeWorkflowInvocation(root, service, 'build-macos', tools), {
    command: '/reviewed/pnpm/bin/pnpm',
    args: [
      '--filter',
      '@app/booking',
      'exec',
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
