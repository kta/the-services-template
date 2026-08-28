import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateProductionSeedConfirmation,
  validateRemoteSeedDatabaseId,
  validateRemoteSeedDatabaseInfo,
  validateRemoteSeedInput,
} from './validate-seed-input.mjs'

test('accepts explicit strong remote seed values', () => {
  assert.deepEqual(
    validateRemoteSeedInput({
      email: 'admin@company.example',
      password: 'a-strong-password',
      pepper: 'p'.repeat(32),
    }),
    [],
  )
})

test('rejects template identity, weak password, and short pepper', () => {
  assert.deepEqual(
    validateRemoteSeedInput({ email: 'admin@example.com', password: 'short', pepper: 'short' }),
    [
      'ADMIN_EMAIL must be an explicit non-template email',
      'ADMIN_PASSWORD must be at least 12 characters',
      'AUTH_PEPPER must be at least 32 UTF-8 bytes',
    ],
  )
})

test('accepts an uppercase email because the seed entry point normalizes it', () => {
  assert.deepEqual(
    validateRemoteSeedInput({
      email: 'Admin@Company.example',
      password: 'a-strong-password',
      pepper: 'p'.repeat(32),
    }),
    [],
  )
})

test('rejects the published development password and oversized email', () => {
  assert.deepEqual(
    validateRemoteSeedInput({
      email: `${'a'.repeat(310)}@example.com`,
      password: 'admin-dev-password-change-me',
      pepper: 'p'.repeat(32),
    }),
    [
      'ADMIN_EMAIL must be at most 320 UTF-8 bytes',
      'ADMIN_PASSWORD must not be a published development/template password',
    ],
  )
})

test('rejects predictable development and test credentials even when they are long', () => {
  assert.deepEqual(
    validateRemoteSeedInput({
      email: 'admin@company.example',
      password: 'e2e-a-long-but-predictable-password',
      pepper: `test-${'p'.repeat(32)}`,
    }),
    [
      'ADMIN_PASSWORD must not be a published development/test value',
      'AUTH_PEPPER must not be a published development/test value',
    ],
  )
})

test('rejects control characters in remote seed material', () => {
  assert.deepEqual(
    validateRemoteSeedInput({
      email: 'admin@company.example',
      password: 'strong-password\n',
      pepper: `${'p'.repeat(31)}\u0000`,
    }),
    [
      'ADMIN_PASSWORD must not contain control characters',
      'AUTH_PEPPER must not contain control characters',
    ],
  )
})

test('requires the literal production seed confirmation', () => {
  assert.equal(validateProductionSeedConfirmation('RESTORE_PRODUCTION'), true)
  assert.throws(
    () => validateProductionSeedConfirmation('yes'),
    /RESTORE_PRODUCTION confirmation is required/,
  )
})

test('requires remote seed database name to resolve to the reviewed UUID', () => {
  const id = '01234567-89ab-4cde-8123-456789abcdef'
  assert.equal(validateRemoteSeedDatabaseInfo(JSON.stringify({ database_id: id }), id), true)
  assert.equal(
    validateRemoteSeedDatabaseInfo(JSON.stringify({ result: { database_id: id } }), id),
    true,
  )
  assert.throws(
    () =>
      validateRemoteSeedDatabaseInfo(
        JSON.stringify({ database_id: 'fedcba98-7654-4321-8765-fedcba987654' }),
        id,
      ),
    /does not resolve to the reviewed database id/,
  )
  assert.throws(
    () => validateRemoteSeedDatabaseInfo('{"database_id":"not-a-uuid"}', id),
    /does not resolve to the reviewed database id/,
  )
})

test('remote seed execution target is the reviewed D1 UUID, never the mutable name', () => {
  assert.equal(
    validateRemoteSeedDatabaseId('01234567-89AB-4CDE-8123-456789ABCDEF'),
    '01234567-89ab-4cde-8123-456789abcdef',
  )
  assert.throws(() => validateRemoteSeedDatabaseId('admin-production'), /reviewed database id/)
})
