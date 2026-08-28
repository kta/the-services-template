import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { validateProductionConfig } from './check-production-config.mjs'

const backupPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
  type: 'spki',
  format: 'pem',
})

test('template admin config is blocked until its D1, binding, and canonical URLs are replaced', () => {
  const violations = validateProductionConfig(
    [
      '{',
      '  "database_id": "00000000-0000-0000-0000-000000000000",',
      '  "service": "example-service",',
      '  "vars": {"APP_ENV": "production"}',
      '}',
    ].join('\n'),
    'admin',
  )
  assert.equal(violations.length, 4)
})

test('production config accepts concrete admin values', () => {
  const violations = validateProductionConfig(
    [
      '{',
      '  "database_id": "12345678-1234-1234-1234-123456789abc",',
      '  "id": "1234567890abcdef1234567890abcdef",',
      '  "binding": "EXAMPLE_SERVICE",',
      '  "service": "my-domain",',
      '  "vars": {"APP_ENV": "production", "OPS_ALERT_EMAIL": "ops@example.com", "INVITE_BASE_URL": "https://admin.example.com", "DOMAIN_NOTIFICATION_TO": "team@example.com"}',
      '}',
    ].join('\n'),
    'admin',
  )
  assert.deepEqual(violations, [])
})

test('notifier and ops reject operational placeholders', () => {
  assert.ok(
    validateProductionConfig(
      '{"id":"00000000000000000000000000000000","vars":{"APP_ENV":"production","MAIL_FROM":""}}',
      'notifier',
    ).length > 0,
  )
  assert.ok(
    validateProductionConfig(
      '{"bucket_name":"app-backups","ADMIN_DB_ID":"00000000-0000-0000-0000-000000000000","vars":{"APP_ENV":"development"}}',
      'ops',
    ).length > 0,
  )
})

test('notifier requires a canonical HTTPS admin origin for invite links', () => {
  const source = JSON.stringify({
    name: 'notifier',
    kv_namespaces: [{ binding: 'DEDUPE', id: '1234567890abcdef1234567890abcdef' }],
    vars: {
      APP_ENV: 'production',
      MAIL_FROM: 'notifications@example.com',
      DOMAIN_NOTIFICATION_TO: 'team@example.com',
      OPS_ALERT_EMAIL: 'ops@example.com',
      INVITE_BASE_URL: 'https://admin.example.com',
    },
  })
  assert.deepEqual(validateProductionConfig(source, 'notifier'), [])
  assert.ok(
    validateProductionConfig(
      source.replace('https://admin.example.com', 'http://admin.example.com'),
      'notifier',
    ).some((violation) => violation.includes('INVITE_BASE_URL')),
  )
})

test('production config requires HTTPS invite URL and operational recipients', () => {
  const source = JSON.stringify({
    database_id: '12345678-1234-1234-1234-123456789abc',
    binding: 'EXAMPLE_SERVICE',
    service: 'my-domain',
    vars: {
      APP_ENV: 'production',
      OPS_ALERT_EMAIL: '',
      INVITE_BASE_URL: 'http://admin.example.com',
    },
  })
  assert.ok(validateProductionConfig(source, 'admin').length >= 2)
})

test('blocks development authentication and mail logging in every production service', () => {
  const domain = JSON.stringify({
    name: 'booking',
    d1_databases: [
      { database_name: 'booking', database_id: '12345678-1234-1234-1234-123456789abc' },
    ],
    services: [{ binding: 'NOTIFIER', service: 'notifier' }],
    vars: { APP_ENV: 'production', AUTH_DEV_GRANT: 'true', AUTH_DEV_PRIVATE_KEY: 'oops' },
  })
  const notifier = JSON.stringify({
    id: '1234567890abcdef1234567890abcdef',
    vars: {
      APP_ENV: 'production',
      MAIL_DEV_LOG: 'true',
      MAIL_FROM: 'from@example.com',
      DOMAIN_NOTIFICATION_TO: 'to@example.com',
      OPS_ALERT_EMAIL: 'ops@example.com',
    },
  })
  assert.ok(validateProductionConfig(domain, 'booking').some((v) => v.includes('AUTH_DEV_GRANT')))
  assert.ok(
    validateProductionConfig(domain, 'booking').some((v) => v.includes('AUTH_DEV_PRIVATE_KEY')),
  )
  assert.ok(validateProductionConfig(notifier, 'notifier').some((v) => v.includes('MAIL_DEV_LOG')))
})

test('ops production config must match the Cloudflare account used by the deploy job', () => {
  const source = JSON.stringify({
    bucket_name: 'real-backups',
    ADMIN_DB_ID: '12345678-1234-1234-1234-123456789abc',
    vars: {
      APP_ENV: 'production',
      CF_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      BACKUP_BUCKET_NAME: 'real-backups',
      OPS_ALERT_EMAIL: 'ops@example.com',
      BACKUP_SIGNING_PUBLIC_KEY: backupPublicKey,
    },
  })
  assert.ok(
    validateProductionConfig(source, 'ops', {
      CLOUDFLARE_ACCOUNT_ID: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }).some((v) => v.includes('CLOUDFLARE_ACCOUNT_ID')),
  )
  assert.deepEqual(
    validateProductionConfig(source, 'ops', {
      CLOUDFLARE_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    [],
  )
})

test('ops D1 variables must match the reviewed Worker bindings', () => {
  const source = JSON.stringify({
    name: 'ops',
    bucket_name: 'real-backups',
    vars: {
      APP_ENV: 'production',
      CF_ACCOUNT_ID: 'account-a',
      BACKUP_BUCKET_NAME: 'real-backups',
      ADMIN_DB_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      BOOKING_DB_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      OPS_ALERT_EMAIL: 'ops@example.com',
      BACKUP_SIGNING_PUBLIC_KEY: backupPublicKey,
    },
  })
  const options = {
    allowedOpsDatabaseVars: ['ADMIN_DB_ID', 'BOOKING_DB_ID'],
    reviewedDatabaseIds: {
      admin: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      booking: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
  }
  assert.deepEqual(validateProductionConfig(source, 'ops', {}, options), [])
  assert.ok(
    validateProductionConfig(
      source.replace(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ),
      'ops',
      {},
      options,
    ).some((violation) => violation.includes('BOOKING_DB_ID')),
  )
})

test('production command preflight pins each Worker name and the shared account', () => {
  const source = JSON.stringify({
    name: 'admin',
    d1_databases: [{ binding: 'DB', database_id: '12345678-1234-1234-1234-123456789abc' }],
    services: [{ binding: 'EXAMPLE_SERVICE', service: 'booking' }],
    vars: {
      APP_ENV: 'production',
      OPS_ALERT_EMAIL: 'ops@example.com',
      INVITE_BASE_URL: 'https://admin.example.com',
    },
  })
  assert.deepEqual(
    validateProductionConfig(
      source,
      'admin',
      { CLOUDFLARE_ACCOUNT_ID: 'account-a' },
      { requireWorkerName: true, reviewedAccountId: 'account-a' },
    ),
    [],
  )
  assert.ok(
    validateProductionConfig(
      source.replace('"name":"admin"', '"name":"other-worker"'),
      'admin',
      { CLOUDFLARE_ACCOUNT_ID: 'account-a' },
      { requireWorkerName: true, reviewedAccountId: 'account-a' },
    ).some((violation) => violation.includes('Worker name')),
  )
  assert.ok(
    validateProductionConfig(
      source,
      'admin',
      { CLOUDFLARE_ACCOUNT_ID: 'account-b' },
      { requireWorkerName: true, reviewedAccountId: 'account-a' },
    ).some((violation) => violation.includes('reviewed ops account')),
  )
})

test('validates effective JSONC values instead of comment decoys', () => {
  const source = [
    '{',
    '  // "database_id": "12345678-1234-1234-1234-123456789abc"',
    '  "d1_databases": [{"database_id": "00000000-0000-0000-0000-000000000000"}],',
    '  "services": [{"binding": "EXAMPLE_SERVICE", "service": "example-service"}],',
    '  "vars": {"APP_ENV": "development", "OPS_ALERT_EMAIL": "", "INVITE_BASE_URL": ""},',
    '}',
  ].join('\n')
  const violations = validateProductionConfig(source, 'admin')
  assert.ok(violations.some((violation) => violation.includes('database_id')))
  assert.ok(violations.some((violation) => violation.includes('APP_ENV')))
  assert.ok(violations.some((violation) => violation.includes('INVITE_BASE_URL')))
})

test('rejects duplicate effective JSONC keys instead of accepting the last one', () => {
  const source = '{"vars":{"APP_ENV":"production","APP_ENV":"development"}}'
  const violations = validateProductionConfig(source, 'admin')
  assert.ok(violations.some((violation) => violation.includes('duplicate key')))
})

test('accepts a concrete copied domain service config', () => {
  const source = JSON.stringify({
    name: 'booking',
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'booking',
        database_id: '12345678-1234-1234-1234-123456789abc',
      },
    ],
    services: [{ binding: 'NOTIFIER', service: 'notifier' }],
    vars: { APP_ENV: 'production', DOMAIN_NOTIFICATION_TO: 'team@example.com' },
  })
  assert.deepEqual(validateProductionConfig(source, 'booking'), [])
})

test('rejects secret-like production vars and non-canonical notifier bindings', () => {
  const source = JSON.stringify({
    name: 'booking',
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'booking',
        database_id: '12345678-1234-1234-1234-123456789abc',
      },
    ],
    services: [{ binding: 'NOTIFIER', service: 'attacker' }],
    vars: {
      APP_ENV: 'production',
      DOMAIN_NOTIFICATION_TO: 'team@example.com',
      INTERNAL_KEY: 'not-a-secret-value',
    },
  })
  const violations = validateProductionConfig(source, 'booking')
  assert.ok(violations.some((violation) => violation.includes('secret-like')))
  assert.ok(violations.some((violation) => violation.includes('notifier service')))
})

test('blocks the scaffold domain config until it is copied and configured', () => {
  const source = JSON.stringify({
    name: 'example-service',
    d1_databases: [{ binding: 'DB', database_id: '00000000-0000-0000-0000-000000000000' }],
    services: [{ binding: 'NOTIFIER', service: 'notifier' }],
    vars: { APP_ENV: 'production' },
  })
  const violations = validateProductionConfig(source, 'booking')
  assert.ok(violations.some((violation) => violation.includes('database_id')))
  assert.ok(violations.some((violation) => violation.includes('scaffold')))
})

test('the relative-path CLI entry point actually runs the production preflight', () => {
  const result = spawnSync(process.execPath, ['scripts/check-production-config.mjs', 'admin'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /production config blocked for admin/)
})
