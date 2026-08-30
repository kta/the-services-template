import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isProductionSecretProvisioningService,
  parseProductionSecretResponse,
  productionSecretGuard,
  productionWorkerSecretsUrl,
  validateProductionSecretNames,
} from './check-production-secrets.mjs'

test('selects one exact checkout guard for deploy versus bootstrap remote inspection', () => {
  assert.deepEqual(productionSecretGuard([]), {
    guardScript: 'require-production-provisioning.mjs',
    allowMissingWorker: false,
  })
  assert.deepEqual(productionSecretGuard(['--deploy']), {
    guardScript: 'require-production-deploy.mjs',
    allowMissingWorker: false,
  })
  assert.deepEqual(productionSecretGuard(['--allow-missing-worker']), {
    guardScript: 'require-production-provisioning.mjs',
    allowMissingWorker: true,
  })
  assert.throws(
    () => productionSecretGuard(['--deploy', '--allow-missing-worker']),
    /one reviewed mode/i,
  )
})

test('uses the structured Cloudflare Worker secret endpoint and fails closed on malformed responses', () => {
  assert.equal(
    productionWorkerSecretsUrl('0123456789abcdef0123456789abcdef', 'booking'),
    'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/booking/secrets',
  )
  assert.deepEqual(
    parseProductionSecretResponse({ success: true, result: [{ name: 'AUTH_PEPPER' }] }),
    [{ name: 'AUTH_PEPPER' }],
  )
  assert.throws(() => parseProductionSecretResponse({ success: false, result: [] }), /invalid/)
  assert.throws(() => parseProductionSecretResponse({ success: true, result: {} }), /invalid/)
})

test('accepts exactly the production secret allowlist', () => {
  const result = validateProductionSecretNames('admin', [
    { name: 'DOMAIN_TO_ADMIN_KEY' },
    { name: 'ADMIN_TO_EXAMPLE_SERVICE_KEY' },
    { name: 'ADMIN_TO_NOTIFIER_KEY' },
    { name: 'JWT_PRIVATE_KEY' },
    { name: 'JWT_PUBLIC_KEY' },
    { name: 'AUTH_PEPPER' },
  ])
  assert.deepEqual(result, { missing: [], unexpected: [] })
})

test('detects stale development or cross-service secret names without reading values', () => {
  const result = validateProductionSecretNames('admin', [
    'DOMAIN_TO_ADMIN_KEY',
    'ADMIN_TO_EXAMPLE_SERVICE_KEY',
    'ADMIN_TO_NOTIFIER_KEY',
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'AUTH_PEPPER',
    'AUTH_DEV_PRIVATE_KEY',
  ])
  assert.deepEqual(result, { missing: [], unexpected: ['AUTH_DEV_PRIVATE_KEY'] })
})

test('reports missing required production secrets', () => {
  assert.deepEqual(validateProductionSecretNames('ops', ['OPS_TO_NOTIFIER_KEY']), {
    missing: ['D1_EXPORT_API_TOKEN', 'R2_POLICY_CHECK_API_TOKEN', 'BACKUP_SIGNING_PRIVATE_KEY'],
    unexpected: [],
  })
})

test('rejects malformed or duplicate remote secret entries instead of filtering them out', () => {
  assert.deepEqual(validateProductionSecretNames('ops', undefined), {
    missing: [
      'OPS_TO_NOTIFIER_KEY',
      'D1_EXPORT_API_TOKEN',
      'R2_POLICY_CHECK_API_TOKEN',
      'BACKUP_SIGNING_PRIVATE_KEY',
    ],
    unexpected: ['<invalid secret response>'],
  })
  assert.deepEqual(
    validateProductionSecretNames('ops', [
      'OPS_TO_NOTIFIER_KEY',
      'D1_EXPORT_API_TOKEN',
      'R2_POLICY_CHECK_API_TOKEN',
      'BACKUP_SIGNING_PRIVATE_KEY',
      'OPS_TO_NOTIFIER_KEY',
      { name: 42 },
    ]),
    { missing: [], unexpected: ['<invalid secret entry>', 'OPS_TO_NOTIFIER_KEY'] },
  )
})

test('accepts the domain-specific admin key selected by the copied domain config', () => {
  assert.deepEqual(
    validateProductionSecretNames(
      'admin',
      [
        'DOMAIN_TO_ADMIN_KEY',
        'ADMIN_TO_BOOKING_KEY',
        'ADMIN_TO_NOTIFIER_KEY',
        'JWT_PRIVATE_KEY',
        'JWT_PUBLIC_KEY',
        'AUTH_PEPPER',
      ],
      { domainService: 'booking' },
    ),
    { missing: [], unexpected: [] },
  )
})

test('validates copied domain services against their reviewed config secret names', () => {
  assert.deepEqual(
    validateProductionSecretNames(
      'booking',
      ['ADMIN_TO_BOOKING_KEY', 'DOMAIN_TO_ADMIN_KEY', 'DOMAIN_TO_NOTIFIER_KEY', 'JWT_PUBLIC_KEY'],
      {
        requiredSecretNames: [
          'ADMIN_TO_BOOKING_KEY',
          'DOMAIN_TO_ADMIN_KEY',
          'DOMAIN_TO_NOTIFIER_KEY',
          'JWT_PUBLIC_KEY',
        ],
      },
    ),
    { missing: [], unexpected: [] },
  )
})

test('rejects JWT private keys on non-admin Workers even if a copied config declares one', () => {
  assert.deepEqual(
    validateProductionSecretNames(
      'booking',
      [
        'ADMIN_TO_BOOKING_KEY',
        'DOMAIN_TO_ADMIN_KEY',
        'DOMAIN_TO_NOTIFIER_KEY',
        'JWT_PUBLIC_KEY',
        'JWT_PRIVATE_KEY',
      ],
      {
        requiredSecretNames: [
          'ADMIN_TO_BOOKING_KEY',
          'DOMAIN_TO_ADMIN_KEY',
          'DOMAIN_TO_NOTIFIER_KEY',
          'JWT_PUBLIC_KEY',
          'JWT_PRIVATE_KEY',
        ],
      },
    ),
    { missing: [], unexpected: ['JWT_PRIVATE_KEY'] },
  )
})

test('rejects the scaffold from production secret provisioning even for a normal rotation', () => {
  assert.equal(isProductionSecretProvisioningService('example_service'), false)
  assert.equal(isProductionSecretProvisioningService('booking'), true)
})
