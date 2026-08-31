import assert from 'node:assert/strict'
import test from 'node:test'
import { validateTauriDevHost } from './tauri-dev-host.mjs'

test('allows loopback and private LAN addresses for explicit native development', () => {
  for (const value of [
    'localhost',
    '127.0.0.1',
    '::1',
    '10.0.0.4',
    '172.20.0.4',
    '192.168.1.4',
    'fd00::4',
  ]) {
    assert.equal(validateTauriDevHost(value), value)
  }
  assert.equal(validateTauriDevHost(undefined), undefined)
  assert.equal(validateTauriDevHost(''), undefined)
})

test('rejects wildcard, public, and hostname dev hosts', () => {
  for (const value of ['0.0.0.0', '::', '8.8.8.8', 'example.com', 'localhost.example']) {
    assert.throws(() => validateTauriDevHost(value), /loopback or private LAN/)
  }
})
