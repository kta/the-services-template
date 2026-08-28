import assert from 'node:assert/strict'
import test from 'node:test'
import { assertRuntimeAccountMatchesConfig, checkR2BucketPrivate } from './check-r2-private.mjs'

const account = 'a'.repeat(32)

test('requires managed and every custom R2 domain to be private', async () => {
  const calls = []
  await assert.doesNotReject(() =>
    checkR2BucketPrivate(account, 'private-backups', 'token', async (input, init) => {
      calls.push({ input: String(input), init })
      if (String(input).endsWith('/domains/managed')) {
        return new Response(JSON.stringify({ success: true, result: { enabled: false } }))
      }
      return new Response(
        JSON.stringify({ success: true, result: { domains: [{ enabled: false }] } }),
      )
    }),
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers.authorization, 'Bearer token')
  await assert.rejects(
    () =>
      checkR2BucketPrivate(
        account,
        'private-backups',
        'token',
        async () => new Response(JSON.stringify({ success: true, result: { enabled: true } })),
      ),
    /managed r2\.dev public access/,
  )
  await assert.rejects(
    () =>
      checkR2BucketPrivate(account, 'private-backups', 'token', async (input) =>
        String(input).endsWith('/domains/managed')
          ? new Response(JSON.stringify({ success: true, result: { enabled: false } }))
          : new Response(
              JSON.stringify({ success: true, result: { domains: [{ enabled: true }] } }),
            ),
      ),
    /custom domains/,
  )
  await assert.rejects(
    () =>
      checkR2BucketPrivate(
        account,
        'private-backups',
        'token',
        async () => new Response(JSON.stringify({ success: false, result: { enabled: false } })),
      ),
    /API response was unsuccessful/,
  )
})

test('does not inspect a bucket in a different runtime account', () => {
  assert.doesNotThrow(() => assertRuntimeAccountMatchesConfig(account, account))
  assert.doesNotThrow(() => assertRuntimeAccountMatchesConfig(account, undefined))
  assert.throws(
    () => assertRuntimeAccountMatchesConfig(account, 'b'.repeat(32)),
    /runtime account does not match/,
  )
})
