import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { nativeWorkflowInvocation } from './native-workflow.mjs'

const root = '/workspace'
const service = {
  directory: 'booking',
  package: '@app/booking',
  native: true,
}

test('derives native build and verifier argv only from normalized catalog identity', () => {
  assert.deepEqual(nativeWorkflowInvocation(root, service, 'build-macos'), {
    command: 'pnpm',
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
  assert.deepEqual(nativeWorkflowInvocation(root, service, 'verify-android-apk'), {
    command: process.execPath,
    args: [
      join(root, 'scripts/check-tauri-artifact.mjs'),
      join(root, 'services/booking/src-tauri/gen/android/app/build/outputs/apk'),
    ],
    cwd: root,
  })
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
