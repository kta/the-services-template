import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

const root = '/workspace'
const service = {
  directory: 'booking',
  package: '@app/booking',
  native: true,
}
const manifest = {
  releaseOrigin: 'https://booking.example.com',
}

test('builds an unsigned release check with only the reviewed build.rs origin', async () => {
  const { nativeReleaseCheckInvocation } = await import('./check-native-release.mjs')
  const invocation = nativeReleaseCheckInvocation(root, service, manifest, {
    HOME: '/runner',
    CARGO_HOME: '/runner/.cargo',
    RUSTUP_HOME: '/runner/.rustup',
    PATH: '/runner/.cargo/bin:/usr/bin:/bin',
    TAURI_BOOKING_API_ORIGIN: 'https://attacker.example',
    CLOUDFLARE_API_TOKEN: 'must-not-reach-cargo',
    APPLE_SIGNING_IDENTITY: 'must-not-reach-cargo',
  })

  assert.deepEqual(invocation, {
    command: 'cargo',
    args: [
      'check',
      '--locked',
      '--release',
      '--manifest-path',
      join(root, 'services/booking/src-tauri/Cargo.toml'),
    ],
    cwd: root,
    environment: {
      HOME: '/runner',
      CARGO_HOME: '/runner/.cargo',
      RUSTUP_HOME: '/runner/.rustup',
      PATH: '/runner/.cargo/bin:/usr/bin:/bin',
      TAURI_BOOKING_API_ORIGIN: 'https://booking.example.com',
    },
  })
})

test('rejects an unnormalized service or non-HTTPS reviewed origin before invoking Cargo', async () => {
  const { nativeReleaseCheckInvocation } = await import('./check-native-release.mjs')
  assert.throws(
    () => nativeReleaseCheckInvocation(root, { ...service, directory: '../booking' }, manifest, {}),
    /normalized catalog native service/i,
  )
  assert.throws(
    () =>
      nativeReleaseCheckInvocation(
        root,
        service,
        { releaseOrigin: 'http://booking.example.com' },
        {},
      ),
    /canonical HTTPS origin/i,
  )
})
