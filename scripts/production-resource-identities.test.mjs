import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { reviewedProductionResources } from './production-resource-identities.mjs'

const backupPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
  type: 'spki',
  format: 'pem',
})

function fixture(config) {
  const root = mkdtempSync(join(tmpdir(), 'production-resources-'))
  mkdirSync(join(root, 'services/ops'), { recursive: true })
  mkdirSync(join(root, 'services/admin'), { recursive: true })
  mkdirSync(join(root, 'services/notifier'), { recursive: true })
  writeFileSync(
    join(root, 'services/ops/wrangler.jsonc'),
    JSON.stringify({
      ...config,
      vars: {
        ADMIN_DB_ID: '01234567-89ab-4cde-8123-456789abcdef',
        BACKUP_SIGNING_PUBLIC_KEY: backupPublicKey,
        ...config.vars,
      },
    }),
  )
  writeFileSync(
    join(root, 'services/admin/wrangler.jsonc'),
    JSON.stringify({
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'admin-production',
          database_id: '01234567-89ab-4cde-8123-456789abcdef',
        },
      ],
    }),
  )
  writeFileSync(
    join(root, 'services/notifier/wrangler.jsonc'),
    JSON.stringify({
      kv_namespaces: [{ binding: 'DEDUPE', id: 'abcdefabcdefabcdefabcdefabcdefab' }],
    }),
  )
  return root
}

test('resolves the reviewed account and binding bucket identity', () => {
  const root = fixture({
    name: 'ops',
    r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'reviewed-backups' }],
    vars: {
      CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      BACKUP_BUCKET_NAME: 'reviewed-backups',
    },
  })
  try {
    assert.deepEqual(reviewedProductionResources(root), {
      accountId: '0123456789abcdef0123456789abcdef',
      bucketName: 'reviewed-backups',
      dedupeId: 'abcdefabcdefabcdefabcdefabcdefab',
      backupSigningPublicKey: backupPublicKey.trim(),
      databaseIdentities: [
        {
          service: 'admin',
          databaseId: '01234567-89ab-4cde-8123-456789abcdef',
          databaseName: 'admin-production',
        },
      ],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects drift between the R2 binding and runtime variable', () => {
  const root = fixture({
    name: 'ops',
    r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'actual-backups' }],
    vars: {
      CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      BACKUP_BUCKET_NAME: 'different-backups',
    },
  })
  try {
    assert.throws(() => reviewedProductionResources(root), /must match/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects drift between ops D1 vars and the service D1 binding', () => {
  const root = fixture({
    name: 'ops',
    r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'reviewed-backups' }],
    vars: {
      CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      BACKUP_BUCKET_NAME: 'reviewed-backups',
      ADMIN_DB_ID: 'fedcba98-7654-4321-8765-fedcba987654',
    },
  })
  try {
    assert.throws(() => reviewedProductionResources(root), /must match services\/admin/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a missing, non-RSA, or undersized backup signing public key', () => {
  for (const value of ['', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----']) {
    const root = fixture({
      name: 'ops',
      r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'reviewed-backups' }],
      vars: {
        CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        BACKUP_BUCKET_NAME: 'reviewed-backups',
        BACKUP_SIGNING_PUBLIC_KEY: value,
      },
    })
    try {
      assert.throws(
        () => reviewedProductionResources(root),
        /BACKUP_SIGNING_PUBLIC_KEY|backup signing/i,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
