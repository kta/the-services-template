import assert from 'node:assert/strict'
import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import * as restoreCli from './restore-d1.mjs'
import {
  authorizeRestoreSelection,
  canonicalJson,
  createPreRestoreArtifact,
  parseRestoreOptions,
  productionRestoreCommand,
  retainPreRestoreArtifact,
  TIME_TRAVEL_RETENTION_SECONDS,
  validateBackupKey,
  validateLocalManifestAgainstRemote,
  validateRestoreCloudflareAccount,
  validateRestoreConfirmation,
  validateRestoreDatabaseBindings,
  validateRestoreDatabaseId,
  validateRestoreDatabaseInfo,
  validateRestoreDatabaseName,
  validateRestoreOperationOptions,
  validateRestoreProvenance,
  validateRestoreSha256,
  validateRestoreSigningPublicKey,
  validateRestoreTarget,
  validateRestoreTimestamp,
  verifyRestoreDatabase,
} from './restore-d1.mjs'
import { loadServiceRepositoryCatalog } from './service-catalog.mjs'

const { privateKey: manifestPrivateKey, publicKey: manifestPublicKey } = generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
  },
)
const manifestPublicKeyPem = manifestPublicKey.export({ type: 'spki', format: 'pem' })
const repositoryCatalog = await loadServiceRepositoryCatalog(process.cwd())

function signedManifest(manifest) {
  const signer = createSign('RSA-SHA256')
  signer.update(canonicalJson(manifest))
  signer.end()
  return {
    ...manifest,
    signatureAlgorithm: 'RSASSA-PKCS1-v1_5-SHA256',
    signature: signer.sign(manifestPrivateKey).toString('base64url'),
  }
}

test('retains the pre-restore artifact until the operator removes it', async () => {
  const sql = `${'-- retained pre-restore export\n'.repeat(40)}CREATE TABLE users (id);\nINSERT INTO users VALUES (1);\n`
  const artifact = await createPreRestoreArtifact('admin', 'admin', {}, (_service, args) => {
    const output = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length)
    if (!output) throw new Error('missing output')
    writeFileSync(output, sql, { mode: 0o600 })
  })
  try {
    assert.equal(existsSync(artifact.path), true)
    assert.equal(readFileSync(artifact.path, 'utf8'), sql)
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(artifact.directory, { recursive: true, force: true })
  }
})

test('accepts the manifest provenance option for import-backup', () => {
  const options = parseRestoreOptions([
    '--confirm',
    'RESTORE_PRODUCTION',
    '--database',
    'admin-restore',
    '--database-id',
    '01234567-89ab-4cde-8123-456789abcdef',
    '--file',
    '/tmp/restore/backup.sql',
    '--manifest',
    '/tmp/restore/latest.json',
    '--key',
    'admin/2026-08-22T00-00-00.sql',
    '--service',
    'admin',
    '--sha256',
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    '--target',
    'admin',
  ])
  assert.equal(validateRestoreOperationOptions('import-backup', options), true)
  assert.deepEqual(options, {
    '--confirm': 'RESTORE_PRODUCTION',
    '--database': 'admin-restore',
    '--database-id': '01234567-89ab-4cde-8123-456789abcdef',
    '--file': '/tmp/restore/backup.sql',
    '--manifest': '/tmp/restore/latest.json',
    '--key': 'admin/2026-08-22T00-00-00.sql',
    '--service': 'admin',
    '--sha256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    '--target': 'admin',
  })
})

test('rejects restore options that belong to another operation', () => {
  assert.throws(
    () =>
      validateRestoreOperationOptions('import-backup', {
        '--database': 'admin-restore',
        '--timestamp': '2026-08-22T00:00:00.000Z',
      }),
    /invalid restore options/,
  )
  assert.throws(
    () =>
      validateRestoreOperationOptions('time-travel-info', {
        '--service': 'admin',
        '--database-id': '01234567-89ab-4cde-8123-456789abcdef',
      }),
    /invalid restore options/,
  )
})

test('builds fixed remote commands without accepting Wrangler overrides', () => {
  assert.deepEqual(productionRestoreCommand('time-travel-info', { database: 'admin' }), [
    'd1',
    'time-travel',
    'info',
    'admin',
  ])
  assert.deepEqual(
    productionRestoreCommand('time-travel-restore', {
      database: 'admin',
      timestamp: '2026-08-22T00:00:00.000Z',
      nowMs: Date.parse('2026-08-28T00:00:00.000Z'),
    }),
    ['d1', 'time-travel', 'restore', 'admin', '--timestamp=2026-08-22T00:00:00.000Z'],
  )
  assert.deepEqual(
    productionRestoreCommand('export-before-restore', {
      database: 'admin',
      databaseId: '01234567-89ab-4cde-8123-456789abcdef',
      output: '/tmp/restore/pre.sql',
    }),
    [
      'd1',
      'export',
      '01234567-89ab-4cde-8123-456789abcdef',
      '--remote',
      '--skip-confirmation',
      '--output=/tmp/restore/pre.sql',
    ],
  )
  assert.deepEqual(
    productionRestoreCommand('download-backup', {
      bucket: 'private-backups',
      key: 'admin/2026-08-22T00-00-00.sql',
      output: '/tmp/restore/backup.sql',
    }),
    [
      'r2',
      'object',
      'get',
      'private-backups/admin/2026-08-22T00-00-00.sql',
      '--file=/tmp/restore/backup.sql',
      '--remote',
    ],
  )
  assert.deepEqual(
    productionRestoreCommand('upload-pre-restore', {
      service: 'admin',
      bucket: 'private-backups',
      key: 'pre-restore/admin/2026-08-22T00-00-00-000Z-run.sql',
      file: '/tmp/restore/pre.sql',
    }),
    [
      'r2',
      'object',
      'put',
      'private-backups/pre-restore/admin/2026-08-22T00-00-00-000Z-run.sql',
      '--file=/tmp/restore/pre.sql',
      '--content-type=application/sql',
      '--remote',
    ],
  )
  assert.deepEqual(productionRestoreCommand('create-restore-db', { database: 'admin-restore' }), [
    'd1',
    'create',
    'admin-restore',
  ])
  assert.deepEqual(
    productionRestoreCommand('import-backup', {
      database: 'admin-restore',
      file: '/tmp/restore/backup.sql',
    }),
    ['d1', 'execute', 'admin-restore', '--remote', '--file=/tmp/restore/backup.sql', '--yes'],
  )
  assert.throws(
    () =>
      productionRestoreCommand('import-backup', {
        database: 'admin-restore',
        databaseId: 'admin-restore-id',
        file: '/tmp/restore/backup.sql',
      }),
    /reviewed UUID/,
  )
})

test('rejects unsafe restore values before any command is built', () => {
  assert.equal(validateRestoreConfirmation('RESTORE_PRODUCTION'), true)
  assert.throws(() => validateRestoreConfirmation('yes'), /explicit confirmation/)
  const nowMs = Date.parse('2026-08-28T00:00:00.000Z')
  const retentionMs = TIME_TRAVEL_RETENTION_SECONDS * 1_000
  assert.equal(validateRestoreTimestamp('2026-08-28T00:00:00.000Z', nowMs), true)
  assert.equal(validateRestoreTimestamp(new Date(nowMs - retentionMs).toISOString(), nowMs), true)
  assert.throws(() => validateRestoreTimestamp(new Date(nowMs + 1).toISOString(), nowMs), /future/)
  assert.throws(
    () => validateRestoreTimestamp(new Date(nowMs - retentionMs - 1).toISOString(), nowMs),
    /7-day retention/,
  )
  assert.throws(() => validateRestoreTimestamp('2026-02-29T00:00:00Z'), /real RFC3339/)
  assert.throws(() => validateRestoreTimestamp('2026-04-31T00:00:00Z'), /real RFC3339/)
  assert.throws(() => validateRestoreTimestamp('2026-08-22T00:00:00Z && evil'), /timestamp/)
  assert.equal(validateBackupKey('latest.json', 'admin'), true)
  assert.equal(validateBackupKey('admin/2026-08-22T00-00-00.sql', 'admin'), true)
  assert.throws(() => validateBackupKey('../secrets', 'admin'), /backup key/)
  assert.throws(() => validateBackupKey('domain/2026-08-22T00-00-00.sql', 'admin'), /backup key/)
  assert.equal(validateRestoreDatabaseName('admin-restore'), true)
  assert.throws(() => validateRestoreDatabaseName('admin;DROP'), /database name/)
  assert.throws(() => validateRestoreDatabaseName('admin'), /-restore/)
  assert.equal(
    validateRestoreDatabaseId('01234567-89AB-4CDE-8123-456789ABCDEF'),
    '01234567-89ab-4cde-8123-456789abcdef',
  )
  assert.throws(() => validateRestoreDatabaseId('admin-restore'), /reviewed UUID/)
  assert.equal(validateRestoreTarget('admin', ['admin'], repositoryCatalog), true)
  assert.throws(
    () => validateRestoreTarget('domain', ['admin'], repositoryCatalog),
    /configured backup target|catalog deployable/,
  )
  assert.equal(
    validateRestoreSha256('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  assert.throws(() => validateRestoreSha256('not-a-sha256'), /SHA-256/)
  assert.equal(
    validateRestoreCloudflareAccount('0123456789abcdef0123456789abcdef', {
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    }),
    true,
  )
  assert.throws(
    () => validateRestoreCloudflareAccount('account-a', { CLOUDFLARE_ACCOUNT_ID: 'account-b' }),
    /exactly match/,
  )
  assert.throws(() => validateRestoreCloudflareAccount('account-a', {}), /exactly match/)
})

test('pure restore selection rejects non-deployable, unknown, and worker-only services for every operation', () => {
  const operations = [
    ['time-travel-info', (service) => ({ '--service': service })],
    ['time-travel-restore', (service) => ({ '--service': service })],
    ['export-before-restore', (service) => ({ '--service': service })],
    ['download-backup', (service) => ({ '--target': service })],
    ['create-restore-db', (service) => ({ '--service': service })],
    ['import-backup', (service) => ({ '--service': service, '--target': service })],
  ]
  for (const service of [
    'example_service',
    'example_tauri_service',
    'unknown_service',
    'notifier',
    'ops',
  ]) {
    assert.throws(
      () => validateRestoreTarget(service, [service], repositoryCatalog),
      /catalog deployable/i,
      `${service} must not be a production D1 restore target`,
    )
    for (const [operation, options] of operations) {
      assert.throws(
        () => authorizeRestoreSelection(operation, options(service), repositoryCatalog),
        /catalog deployable/i,
        `${operation} must reject ${service}`,
      )
    }
  }
})

test('restore preflight binds ops database ids and public key to reviewed values', () => {
  assert.equal(
    validateRestoreDatabaseBindings(
      {
        admin: '01234567-89ab-4cde-8123-456789abcdef',
        booking: '11234567-89ab-4cde-8123-456789abcdef',
      },
      {
        admin: '01234567-89ab-4cde-8123-456789abcdef',
        booking: '11234567-89ab-4cde-8123-456789abcdef',
      },
    ),
    true,
  )
  assert.throws(
    () =>
      validateRestoreDatabaseBindings(
        { admin: '01234567-89ab-4cde-8123-456789abcdef' },
        { admin: '21234567-89ab-4cde-8123-456789abcdef' },
      ),
    /does not match/,
  )
  assert.equal(validateRestoreSigningPublicKey(manifestPublicKeyPem, manifestPublicKeyPem), true)
  assert.throws(
    () =>
      validateRestoreSigningPublicKey(
        manifestPublicKeyPem,
        generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
          type: 'spki',
          format: 'pem',
        }),
      ),
    /does not match/,
  )
  assert.throws(() => validateRestoreSigningPublicKey('', manifestPublicKeyPem), /must be provided/)
})

test('restore destination verification requires the exact D1 UUID returned by Wrangler', () => {
  assert.equal(
    validateRestoreDatabaseInfo(
      JSON.stringify({ database_id: '01234567-89ab-4cde-8123-456789abcdef' }),
      '01234567-89AB-4CDE-8123-456789ABCDEF',
    ),
    true,
  )
  assert.throws(
    () =>
      validateRestoreDatabaseInfo(
        JSON.stringify({ database_id: '21234567-89ab-4cde-8123-456789abcdef' }),
        '01234567-89ab-4cde-8123-456789abcdef',
      ),
    /does not resolve/,
  )
})

test('time-travel operations verify the configured source name resolves to its reviewed UUID', () => {
  const expectedId = '01234567-89ab-4cde-8123-456789abcdef'
  const calls = []
  verifyRestoreDatabase('admin', 'admin', expectedId, {}, (_service, args) => {
    calls.push(args)
    return JSON.stringify({ database_id: expectedId })
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['d1', 'info', 'admin', '--json'])
  assert.throws(
    () =>
      verifyRestoreDatabase('admin', 'admin', expectedId, {}, () =>
        JSON.stringify({ database_id: '11234567-89ab-4cde-8123-456789abcdef' }),
      ),
    /does not resolve/,
  )
})

test('restore manifest must bind the requested object to the reviewed account and database', () => {
  const manifest = signedManifest({
    targets: {
      admin: {
        at: '2026-08-22T00:00:00.000Z',
        key: 'admin/2026-08-22T00-00-00.sql',
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        accountId: 'account-a',
        databaseId: '01234567-89ab-4cde-8123-456789abcdef',
      },
    },
  })
  assert.deepEqual(
    validateRestoreProvenance(
      manifest,
      'admin',
      'account-a',
      '01234567-89AB-4CDE-8123-456789ABCDEF',
      { key: 'admin/2026-08-22T00-00-00.sql', signingPublicKey: manifestPublicKeyPem },
    ),
    {
      key: 'admin/2026-08-22T00-00-00.sql',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
  )
  assert.throws(
    () =>
      validateRestoreProvenance(
        manifest,
        'admin',
        'account-b',
        '01234567-89ab-4cde-8123-456789abcdef',
        { signingPublicKey: manifestPublicKeyPem },
      ),
    /provenance/,
  )
  assert.throws(
    () =>
      validateRestoreProvenance(
        manifest,
        'admin',
        'account-a',
        '01234567-89ab-4cde-8123-456789abcdee',
        { signingPublicKey: manifestPublicKeyPem },
      ),
    /provenance/,
  )
})

test('import provenance must match the manifest fetched from R2', () => {
  const remote = {
    key: 'admin/2026-08-22T00-00-00.sql',
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  }
  const local = signedManifest({
    targets: {
      admin: {
        key: remote.key,
        sha256: remote.sha256,
        accountId: 'account-a',
        databaseId: '01234567-89ab-4cde-8123-456789abcdef',
      },
    },
  })
  assert.deepEqual(
    validateLocalManifestAgainstRemote(
      local,
      'admin',
      'account-a',
      '01234567-89ab-4cde-8123-456789abcdef',
      remote,
      { ...remote, signingPublicKey: manifestPublicKeyPem },
    ),
    remote,
  )
  assert.throws(
    () =>
      validateLocalManifestAgainstRemote(
        {
          ...local,
          targets: { admin: { ...local.targets.admin, key: 'admin/2026-08-21T00-00-00.sql' } },
        },
        'admin',
        'account-a',
        '01234567-89ab-4cde-8123-456789abcdef',
        remote,
        { ...remote, signingPublicKey: manifestPublicKeyPem },
      ),
    /requested object|R2 manifest|signature/,
  )
})

test('rejects unsigned restore provenance', () => {
  const manifest = {
    targets: {
      admin: {
        at: '2026-08-22T00:00:00.000Z',
        key: 'admin/2026-08-22T00-00-00.sql',
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        accountId: 'account-a',
        databaseId: '01234567-89ab-4cde-8123-456789abcdef',
      },
    },
  }
  assert.throws(
    () =>
      validateRestoreProvenance(
        manifest,
        'admin',
        'account-a',
        '01234567-89ab-4cde-8123-456789abcdef',
        { signingPublicKey: manifestPublicKeyPem },
      ),
    /signature/,
  )
})

test('time-travel pre-restore state is uploaded and read back before proceeding', async () => {
  const sql = `${'-- retained pre-restore export\n'.repeat(40)}CREATE TABLE users (id);\nINSERT INTO users VALUES (1);\n`
  const artifact = await createPreRestoreArtifact('admin', 'admin', {}, (_service, args) => {
    const output = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length)
    if (!output) throw new Error('missing output')
    writeFileSync(output, sql, { mode: 0o600 })
  })
  const calls = []
  try {
    const key = await retainPreRestoreArtifact(
      artifact,
      { bucket: 'private-backups' },
      'admin',
      {},
      (_service, args) => {
        calls.push(args)
        if (args[1] === 'object' && args[2] === 'get') {
          const output = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
          if (!output) throw new Error('missing verification output')
          writeFileSync(output, sql, { mode: 0o600 })
        }
      },
    )
    assert.match(key, /^pre-restore\/admin\//)
    assert.equal(calls.length, 2)
  } finally {
    rmSync(artifact.directory, { recursive: true, force: true })
  }
})

test('every CLI operation reaches checkout, config, R2 preflight, and its fixed command', async () => {
  assert.equal(typeof restoreCli.runRestoreCli, 'function')

  const accountId = '0123456789abcdef0123456789abcdef'
  const adminDatabaseId = '01234567-89ab-4cde-8123-456789abcdef'
  const restoreDatabaseId = '11234567-89ab-4cde-8123-456789abcdef'
  const backupKey = 'admin/2026-08-22T00-00-00.sql'
  const sql = `${'-- reviewed restore fixture\n'.repeat(40)}CREATE TABLE users (id);\nINSERT INTO users VALUES (1);\n`
  const sha256 = createHash('sha256').update(sql).digest('hex')
  const manifest = signedManifest({
    targets: {
      admin: {
        at: '2026-08-22T00:00:00.000Z',
        key: backupKey,
        sha256,
        accountId,
        databaseId: adminDatabaseId,
      },
    },
  })
  const environment = {
    PATH: process.env.PATH,
    CLOUDFLARE_API_TOKEN: 'restore-operator-token',
    CLOUDFLARE_ACCOUNT_ID: accountId,
    BACKUP_SIGNING_PUBLIC_KEY: manifestPublicKeyPem,
  }
  const configs = {
    admin: {
      databaseName: 'admin',
      databaseId: adminDatabaseId,
      accountId,
      bucket: '',
      backupTargets: [],
      databaseIds: {},
      signingPublicKey: '',
    },
    ops: {
      databaseName: '',
      databaseId: '',
      accountId,
      bucket: 'private-backups',
      backupTargets: ['admin'],
      databaseIds: { admin: adminDatabaseId },
      signingPublicKey: manifestPublicKeyPem,
    },
  }
  const cases = [
    {
      name: 'time-travel-info',
      argv: ['time-travel-info', '--service', 'admin'],
      final: ['d1', 'time-travel', 'info', adminDatabaseId],
    },
    {
      name: 'time-travel-restore',
      argv: [
        'time-travel-restore',
        '--service',
        'admin',
        '--timestamp',
        '2026-08-22T00:00:00.000Z',
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
      final: [
        'd1',
        'time-travel',
        'restore',
        adminDatabaseId,
        '--timestamp=2026-08-22T00:00:00.000Z',
      ],
    },
    {
      name: 'export-before-restore',
      argv: ['export-before-restore', '--service', 'admin', '--confirm', 'RESTORE_PRODUCTION'],
      output: { option: '--output', extension: '.sql' },
      finalPrefix: ['d1', 'export', adminDatabaseId, '--remote', '--skip-confirmation'],
    },
    {
      name: 'download-backup',
      argv: [
        'download-backup',
        '--target',
        'admin',
        '--key',
        backupKey,
        '--sha256',
        sha256,
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
      output: { option: '--output', extension: '.sql' },
      finalPrefix: ['r2', 'object', 'get', `private-backups/${backupKey}`],
    },
    {
      name: 'create-restore-db',
      argv: [
        'create-restore-db',
        '--service',
        'admin',
        '--database',
        'admin-restore',
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
      final: ['d1', 'create', 'admin-restore'],
    },
    {
      name: 'import-backup',
      argv: [
        'import-backup',
        '--service',
        'admin',
        '--database',
        'admin-restore',
        '--database-id',
        restoreDatabaseId,
        '--target',
        'admin',
        '--key',
        backupKey,
        '--sha256',
        sha256,
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
      inputs: true,
      finalPrefix: ['d1', 'execute', restoreDatabaseId, '--remote'],
    },
  ]

  for (const scenario of cases) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), `restore-cli-${scenario.name}-`)))
    chmodSync(directory, 0o700)
    const events = []
    const argv = [...scenario.argv]
    if (scenario.output) {
      argv.push(scenario.output.option, join(directory, `result${scenario.output.extension}`))
    }
    if (scenario.inputs) {
      const input = join(directory, 'restore.sql')
      const localManifest = join(directory, 'latest.json')
      writeFileSync(input, sql, { mode: 0o600 })
      writeFileSync(localManifest, JSON.stringify(manifest), { mode: 0o600 })
      argv.push('--file', input, '--manifest', localManifest)
    }

    try {
      await restoreCli.runRestoreCli(argv, {
        environment,
        nowMs: Date.parse('2026-08-28T00:00:00.000Z'),
        serviceConfig(service) {
          const config = configs[service]
          if (!config) throw new Error(`unexpected config ${service}`)
          return config
        },
        execFileSync(_command, args, options) {
          events.push({ kind: 'preflight', script: basename(args[0]), env: options.env })
        },
        runProductionWrangler(args) {
          events.push({ kind: 'wrangler', args: [...args] })
          if (args[0] === 'd1' && args[1] === 'info') {
            return JSON.stringify({
              database_id: args[2] === 'admin-restore' ? restoreDatabaseId : adminDatabaseId,
            })
          }
          const outputOption = args.find(
            (arg) => arg.startsWith('--output=') || arg.startsWith('--file='),
          )
          if (args[0] === 'd1' && args[1] === 'export' && outputOption) {
            writeFileSync(outputOption.slice('--output='.length), sql, { mode: 0o600 })
          }
          if (args[0] === 'r2' && args[1] === 'object' && args[2] === 'get' && outputOption) {
            const output = outputOption.slice('--file='.length)
            writeFileSync(
              output,
              args[3].endsWith('/latest.json') ? JSON.stringify(manifest) : sql,
              { mode: 0o600 },
            )
          }
          return undefined
        },
        logger: { log() {}, error() {} },
      })

      assert.deepEqual(
        events.filter((event) => event.kind === 'preflight').map((event) => event.script),
        [
          'require-production-provisioning.mjs',
          'check-production-config.mjs',
          'check-r2-private.mjs',
        ],
        scenario.name,
      )
      const preflightEvents = events.filter((event) => event.kind === 'preflight')
      assert.equal(preflightEvents[0].env.CLOUDFLARE_API_TOKEN, undefined, scenario.name)
      assert.equal(preflightEvents[0].env.CLOUDFLARE_ACCOUNT_ID, undefined, scenario.name)
      for (const event of preflightEvents.slice(1)) {
        assert.equal(event.env.CLOUDFLARE_API_TOKEN, 'restore-operator-token', scenario.name)
        assert.equal(event.env.CLOUDFLARE_ACCOUNT_ID, accountId, scenario.name)
      }
      const commandEvents = events.filter((event) => event.kind === 'wrangler')
      if (scenario.final) {
        assert.ok(
          commandEvents.some(
            (event) => JSON.stringify(event.args) === JSON.stringify(scenario.final),
          ),
          scenario.name,
        )
      } else {
        assert.ok(
          commandEvents.some((event) =>
            scenario.finalPrefix.every((value, index) => event.args[index] === value),
          ),
          scenario.name,
        )
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('every CLI operation rejects non-deployable, unknown, and worker-only services immediately after the checkout guard', async (t) => {
  const accountId = '0123456789abcdef0123456789abcdef'
  const adminDatabaseId = '01234567-89ab-4cde-8123-456789abcdef'
  const selectedDatabaseId = '11234567-89ab-4cde-8123-456789abcdef'
  const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  const invalidServices = [
    'example_service',
    'example_tauri_service',
    'unknown_service',
    'notifier',
    'ops',
  ]
  const operations = [
    {
      name: 'time-travel-info',
      argv: (service) => ['time-travel-info', '--service', service],
    },
    {
      name: 'time-travel-restore',
      argv: (service) => [
        'time-travel-restore',
        '--service',
        service,
        '--timestamp',
        '2026-08-22T00:00:00.000Z',
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
    },
    {
      name: 'export-before-restore',
      argv: (service, directory) => [
        'export-before-restore',
        '--service',
        service,
        '--output',
        join(directory, `${service}.sql`),
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
    },
    {
      name: 'download-backup',
      argv: (service, directory) => [
        'download-backup',
        '--target',
        service,
        '--key',
        `${service}/2026-08-22T00-00-00.sql`,
        '--sha256',
        sha256,
        '--output',
        join(directory, `${service}.sql`),
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
    },
    {
      name: 'create-restore-db',
      argv: (service) => [
        'create-restore-db',
        '--service',
        service,
        '--database',
        `${service}-restore`,
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
    },
    {
      name: 'import-backup',
      argv: (service, directory) => [
        'import-backup',
        '--service',
        service,
        '--database',
        `${service}-restore`,
        '--database-id',
        selectedDatabaseId,
        '--target',
        service,
        '--key',
        `${service}/2026-08-22T00-00-00.sql`,
        '--sha256',
        sha256,
        '--file',
        join(directory, 'restore.sql'),
        '--manifest',
        join(directory, 'latest.json'),
        '--confirm',
        'RESTORE_PRODUCTION',
      ],
    },
  ]

  for (const operation of operations) {
    for (const service of invalidServices) {
      await t.test(`${operation.name}: ${service}`, async () => {
        const directory = realpathSync(
          mkdtempSync(join(tmpdir(), `restore-catalog-${operation.name}-${service}-`)),
        )
        chmodSync(directory, 0o700)
        writeFileSync(join(directory, 'restore.sql'), '-- unreachable input\n', { mode: 0o600 })
        writeFileSync(join(directory, 'latest.json'), '{}\n', { mode: 0o600 })
        const events = []
        try {
          await assert.rejects(
            () =>
              restoreCli.runRestoreCli(operation.argv(service, directory), {
                environment: {
                  PATH: process.env.PATH,
                  CLOUDFLARE_API_TOKEN: 'restore-operator-token',
                  CLOUDFLARE_ACCOUNT_ID: accountId,
                  BACKUP_SIGNING_PUBLIC_KEY: manifestPublicKeyPem,
                },
                nowMs: Date.parse('2026-08-28T00:00:00.000Z'),
                async loadServiceRepositoryCatalog() {
                  events.push('catalog')
                  return repositoryCatalog
                },
                serviceConfig(requestedService) {
                  events.push(`config:${requestedService}`)
                  if (requestedService === 'ops') {
                    return {
                      databaseName: 'ops',
                      databaseId: selectedDatabaseId,
                      accountId,
                      bucket: 'private-backups',
                      backupTargets: [service],
                      databaseIds: { [service]: selectedDatabaseId },
                      signingPublicKey: manifestPublicKeyPem,
                    }
                  }
                  return {
                    databaseName: requestedService,
                    databaseId: requestedService === 'admin' ? adminDatabaseId : selectedDatabaseId,
                    accountId,
                    bucket: '',
                    backupTargets: [],
                    databaseIds: {},
                    signingPublicKey: '',
                  }
                },
                execFileSync(_command, args) {
                  events.push(`preflight:${basename(args[0])}`)
                },
                runProductionWrangler() {
                  events.push('wrangler')
                  throw new Error('Wrangler must not run for an unauthorized restore target')
                },
                logger: { log() {}, error() {} },
              }),
            /catalog deployable/i,
          )
          assert.deepEqual(events, ['preflight:require-production-provisioning.mjs', 'catalog'])
          assert.equal(existsSync(join(directory, `${service}.sql`)), false)
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      })
    }
  }
})
