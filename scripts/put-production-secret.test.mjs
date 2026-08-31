import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  isAllowedProductionSecret,
  isConfiguredDomainService,
  requiredProductionSecretBundleNames,
  requiredProductionSecretNames,
  targetProductionSecretValues,
  validateProductionSecretBundle,
  validateProductionSecretMaterial,
} from './put-production-secret.mjs'

const script = fileURLToPath(new URL('./put-production-secret.mjs', import.meta.url))

function keyPair() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function validBundle() {
  const pair = keyPair()
  return {
    JWT_PRIVATE_KEY: pair.privateKey,
    JWT_PUBLIC_KEY: pair.publicKey,
    ADMIN_TO_NOTIFIER_KEY: randomBytes(32).toString('hex'),
    DOMAIN_TO_NOTIFIER_KEY: randomBytes(32).toString('hex'),
    OPS_TO_NOTIFIER_KEY: randomBytes(32).toString('hex'),
    AUTH_PEPPER: randomBytes(32).toString('base64'),
  }
}

function backupBundle() {
  const pair = keyPair()
  return {
    BACKUP_SIGNING_PRIVATE_KEY: pair.privateKey,
    BACKUP_SIGNING_PUBLIC_KEY: pair.publicKey,
  }
}

test('CLI never performs local production secret writes', () => {
  const result = spawnSync(
    process.execPath,
    [
      script,
      'admin',
      'AUTH_PEPPER',
      '--file',
      '/nonexistent/secret',
      '--bundle',
      '/nonexistent/bundle',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr,
    /protected production workflow.*production-bootstrap\.yml|workflow-only/,
  )
})

test('accepts a generated production key bundle with distinct caller keys', () => {
  assert.deepEqual(validateProductionSecretMaterial(validBundle()), [])
})

test('rejects the committed JWT fixture and published development placeholders', () => {
  const values = validBundle()
  values.JWT_PUBLIC_KEY =
    '-----BEGIN PUBLIC KEY-----MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr/8fe+C79S0HSsonEKqgOI6qFJ4Usgsx7WItD7/zLlVxgheumFwMFWjkSNbDSXMSWZPNIHZ5XyLuspLpS5MJxPiTeY5m0DypT76Cy1b+RG5PPnlTF+2rekGWeK81ej04ll85XKT5TM9HcposcGGGnTa/aAeh6iRMAjUjAdBAmRQynSDNud+DiLydP3FKhXZprhVdDF/gYU7lIsqgZy8+vviAr+sPqBTMdW7F1gw60k3ZGMsJ3+Ex2hwLHmllPZm/+8yoaFGRuKeepNghz8dVmpB9d9tTakOHrbcPoqWeBeR6R+tRg/RoxuU54PUzNeiakOlYMM/UnUdjfI/0SgGjEwIDAQAB-----END PUBLIC KEY-----'
  values.ADMIN_TO_NOTIFIER_KEY = 'dev-admin-to-notifier-key-000000000000'
  const violations = validateProductionSecretMaterial(values)
  assert.ok(violations.some((violation) => violation.includes('JWT_PUBLIC_KEY')))
  assert.ok(violations.some((violation) => violation.includes('development/template')))
})

test('rejects duplicate direction keys and a mismatched JWT pair', () => {
  const values = validBundle()
  values.DOMAIN_TO_NOTIFIER_KEY = values.ADMIN_TO_NOTIFIER_KEY
  const other = keyPair()
  values.JWT_PUBLIC_KEY = other.publicKey
  const violations = validateProductionSecretMaterial(values)
  assert.ok(violations.some((violation) => violation.includes('duplicate')))
  assert.ok(violations.some((violation) => violation.includes('JWT key pair')))
})

test('rejects a private PEM supplied where the public JWT key is required', () => {
  const values = validBundle()
  values.JWT_PUBLIC_KEY = values.JWT_PRIVATE_KEY

  const violations = validateProductionSecretMaterial(values)
  assert.ok(
    violations.some(
      (violation) => violation.includes('JWT_PUBLIC_KEY') && violation.includes('public key'),
    ),
  )
})

test('rejects reuse between internal keys and every other production secret', () => {
  const values = validBundle()
  values.AUTH_PEPPER = values.ADMIN_TO_NOTIFIER_KEY
  values.D1_EXPORT_API_TOKEN = values.ADMIN_TO_NOTIFIER_KEY

  const violations = validateProductionSecretMaterial(values)
  assert.ok(
    violations.some(
      (violation) => violation.includes('AUTH_PEPPER') && violation.includes('duplicate'),
    ),
  )
  assert.ok(
    violations.some(
      (violation) => violation.includes('D1_EXPORT_API_TOKEN') && violation.includes('duplicate'),
    ),
  )
})

test('rejects semantic RSA-key reuse across JWT, backup, and internal boundaries', () => {
  const values = { ...validBundle(), ...backupBundle() }
  values.ADMIN_TO_NOTIFIER_KEY = values.JWT_PUBLIC_KEY
  values.BACKUP_SIGNING_PRIVATE_KEY = values.JWT_PRIVATE_KEY

  const violations = validateProductionSecretMaterial(values)
  assert.ok(
    violations.some(
      (violation) =>
        violation.includes('ADMIN_TO_NOTIFIER_KEY') && violation.includes('cryptographic key'),
    ),
  )
  assert.ok(
    violations.some(
      (violation) =>
        violation.includes('BACKUP_SIGNING_PRIVATE_KEY') && violation.includes('cryptographic key'),
    ),
  )
})

test('allows only the intended public/private half of each dedicated RSA pair to match', () => {
  const jwt = keyPair()
  const backup = keyPair()
  assert.deepEqual(
    validateProductionSecretMaterial({
      JWT_PRIVATE_KEY: jwt.privateKey,
      JWT_PUBLIC_KEY: jwt.publicKey,
      BACKUP_SIGNING_PRIVATE_KEY: backup.privateKey,
      BACKUP_SIGNING_PUBLIC_KEY: backup.publicKey,
      ADMIN_TO_NOTIFIER_KEY: randomBytes(32).toString('hex'),
    }),
    [],
  )
})

test('rejects a backup signing private/public pair mismatch', () => {
  const first = keyPair()
  const second = keyPair()
  const violations = validateProductionSecretMaterial({
    BACKUP_SIGNING_PRIVATE_KEY: first.privateKey,
    BACKUP_SIGNING_PUBLIC_KEY: second.publicKey,
  })
  assert.ok(violations.some((violation) => violation.includes('backup signing key pair')))
})

test('requires copied domain services to use their own admin-to-domain key name', () => {
  assert.equal(isAllowedProductionSecret('booking', 'ADMIN_TO_BOOKING_KEY'), true)
  assert.equal(isAllowedProductionSecret('booking', 'ADMIN_TO_INVENTORY_KEY'), false)
  assert.equal(isAllowedProductionSecret('booking', 'ADMIN_TO_DOMAIN_KEY'), false)
  assert.equal(isAllowedProductionSecret('admin', 'ADMIN_TO_ADMIN_KEY'), false)
  assert.equal(isAllowedProductionSecret('notifier', 'ADMIN_TO_NOTIFIER_KEY'), true)
  assert.equal(
    isAllowedProductionSecret('admin', 'ADMIN_TO_BOOKING_KEY', { domainService: 'booking' }),
    true,
  )
  assert.equal(isAllowedProductionSecret('admin', 'ADMIN_TO_NOTIFIER_KEY'), true)
  assert.equal(isAllowedProductionSecret('admin', 'ADMIN_TO_ADMIN_KEY'), false)
})

test('bootstrap domain input must match the reviewed admin service binding', () => {
  assert.equal(isConfiguredDomainService('booking', 'booking'), true)
  assert.equal(isConfiguredDomainService('booking_service', 'booking-service'), true)
  assert.equal(isConfiguredDomainService('booking', 'inventory'), false)
  assert.equal(isConfiguredDomainService('booking', undefined), false)
})

test('requires a copied domain provisioning bundle to include live auth and only the public JWT half', () => {
  assert.deepEqual(requiredProductionSecretNames('booking'), [
    'ADMIN_TO_BOOKING_KEY',
    'DOMAIN_TO_ADMIN_KEY',
    'DOMAIN_TO_NOTIFIER_KEY',
    'JWT_PUBLIC_KEY',
  ])
  assert.ok(!requiredProductionSecretNames('example_service').includes('JWT_PRIVATE_KEY'))
  assert.deepEqual(
    requiredProductionSecretNames('admin', { domainService: 'booking' }).filter((name) =>
      name.startsWith('ADMIN_TO_'),
    ),
    ['ADMIN_TO_BOOKING_KEY', 'ADMIN_TO_NOTIFIER_KEY'],
  )
  assert.equal(
    isAllowedProductionSecret('admin', 'ADMIN_TO_EXAMPLE_SERVICE_KEY', {
      domainService: 'booking',
    }),
    false,
  )
})

test('bootstrap secret files contain only target secrets and never a domain private key', () => {
  const values = {
    ...validBundle(),
    ADMIN_TO_BOOKING_KEY: randomBytes(32).toString('hex'),
    DOMAIN_TO_ADMIN_KEY: randomBytes(32).toString('hex'),
    D1_EXPORT_API_TOKEN: randomBytes(32).toString('hex'),
  }

  assert.deepEqual(Object.keys(targetProductionSecretValues('booking', values)).sort(), [
    'ADMIN_TO_BOOKING_KEY',
    'DOMAIN_TO_ADMIN_KEY',
    'DOMAIN_TO_NOTIFIER_KEY',
    'JWT_PUBLIC_KEY',
  ])
  assert.equal(targetProductionSecretValues('booking', values).JWT_PRIVATE_KEY, undefined)
  assert.equal(
    targetProductionSecretValues('admin', values, { domainService: 'booking' })
      .ADMIN_TO_EXAMPLE_SERVICE_KEY,
    undefined,
  )
})

test('single-domain rotation requires one complete reviewed bundle instead of a partial Worker bundle', () => {
  const partial = validBundle()
  const missing = validateProductionSecretBundle(partial)
  assert.ok(missing.some((violation) => violation.includes('DOMAIN_TO_ADMIN_KEY')))
  assert.ok(missing.some((violation) => violation.includes('RESEND_API_KEY')))
  assert.ok(missing.some((violation) => violation.includes('D1_EXPORT_API_TOKEN')))

  const backup = keyPair()
  const complete = {
    ...partial,
    DOMAIN_TO_ADMIN_KEY: randomBytes(32).toString('hex'),
    RESEND_API_KEY: randomBytes(32).toString('hex'),
    D1_EXPORT_API_TOKEN: randomBytes(32).toString('hex'),
    R2_POLICY_CHECK_API_TOKEN: randomBytes(32).toString('hex'),
    BACKUP_SIGNING_PRIVATE_KEY: backup.privateKey,
  }
  assert.deepEqual(validateProductionSecretBundle(complete), [])
  assert.ok(requiredProductionSecretBundleNames().includes('BACKUP_SIGNING_PRIVATE_KEY'))
  assert.ok(!requiredProductionSecretBundleNames().includes('ADMIN_TO_EXAMPLE_SERVICE_KEY'))
})

test('bootstrap bundle fails closed when more than one deployable domain is configured', () => {
  const jwt = keyPair()
  const backup = keyPair()
  const values = {
    JWT_PRIVATE_KEY: jwt.privateKey,
    JWT_PUBLIC_KEY: jwt.publicKey,
    DOMAIN_TO_ADMIN_KEY: randomBytes(32).toString('hex'),
    ADMIN_TO_BOOKING_KEY: randomBytes(32).toString('hex'),
    ADMIN_TO_INVENTORY_KEY: randomBytes(32).toString('hex'),
    ADMIN_TO_NOTIFIER_KEY: randomBytes(32).toString('hex'),
    DOMAIN_TO_NOTIFIER_KEY: randomBytes(32).toString('hex'),
    OPS_TO_NOTIFIER_KEY: randomBytes(32).toString('hex'),
    AUTH_PEPPER: randomBytes(32).toString('hex'),
    RESEND_API_KEY: randomBytes(32).toString('hex'),
    D1_EXPORT_API_TOKEN: randomBytes(32).toString('hex'),
    R2_POLICY_CHECK_API_TOKEN: randomBytes(32).toString('hex'),
    BACKUP_SIGNING_PRIVATE_KEY: backup.privateKey,
  }

  assert.deepEqual(
    validateProductionSecretBundle(values, { domainServices: ['booking', 'inventory'] }),
    ['production secret bundle supports at most one deployable domain'],
  )
})
