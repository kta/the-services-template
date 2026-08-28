#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveValues, parseJsonc } from './check-production-config.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MIN_KEY_BYTES = 32
const KNOWN_TEST_PUBLIC_FINGERPRINT =
  'f713e9c9261b62444d73646bdfa2c75794a1782d8ec8139369bd3658cd6ea188'

// These are intentionally public template values. Rejecting their use here
// turns the documented provisioning path into a fail-closed boundary instead
// of relying on an operator to remember that `secret list` never reveals data.
const KNOWN_DEVELOPMENT_VALUES = new Set([
  'dev-auth-pepper-change-me',
  'dev-domain-to-admin-key-000000000000',
  'dev-admin-to-domain-key-000000000000',
  'dev-admin-to-example-service-key-000000000000',
  'dev-admin-to-notifier-key-000000000000',
  'dev-domain-to-notifier-key-000000000000',
  'dev-ops-to-notifier-key-000000000000',
  'dev-d1-export-token',
])

const SERVICE_SECRET_POLICY = {
  admin: new Set([
    'DOMAIN_TO_ADMIN_KEY',
    'ADMIN_TO_EXAMPLE_SERVICE_KEY',
    'ADMIN_TO_NOTIFIER_KEY',
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'AUTH_PEPPER',
  ]),
  example_service: new Set([
    'ADMIN_TO_EXAMPLE_SERVICE_KEY',
    'DOMAIN_TO_ADMIN_KEY',
    'DOMAIN_TO_NOTIFIER_KEY',
    'JWT_PUBLIC_KEY',
  ]),
  notifier: new Set([
    'ADMIN_TO_NOTIFIER_KEY',
    'DOMAIN_TO_NOTIFIER_KEY',
    'OPS_TO_NOTIFIER_KEY',
    'RESEND_API_KEY',
  ]),
  ops: new Set([
    'OPS_TO_NOTIFIER_KEY',
    'D1_EXPORT_API_TOKEN',
    'R2_POLICY_CHECK_API_TOKEN',
    'BACKUP_SIGNING_PRIVATE_KEY',
  ]),
}

function isSafeServiceName(service) {
  return typeof service === 'string' && /^[a-z][a-z0-9_]*$/.test(service)
}

export function isConfiguredDomainService(service, configuredWorkerName) {
  return (
    isSafeServiceName(service) &&
    typeof configuredWorkerName === 'string' &&
    configuredWorkerName === service.replaceAll('_', '-')
  )
}

function adminToDomainSecretName(domainService) {
  if (typeof domainService !== 'string') return null
  const suffix = domainService.replaceAll('-', '_').toUpperCase()
  return /^[A-Z][A-Z0-9_]*$/.test(suffix) ? `ADMIN_TO_${suffix}_KEY` : null
}

function isAllowedProductionSecret(service, secret, options = {}) {
  return requiredProductionSecretNames(service, options).includes(secret)
}

export function requiredProductionSecretNames(service, options = {}) {
  if (service === 'admin') {
    const configured = adminToDomainSecretName(options.domainService)
    return [...SERVICE_SECRET_POLICY.admin].map((name) =>
      name === 'ADMIN_TO_EXAMPLE_SERVICE_KEY' && configured ? configured : name,
    )
  }
  if (service === 'example_service') {
    return [...SERVICE_SECRET_POLICY.example_service]
  }
  if (SERVICE_SECRET_POLICY[service]) return [...SERVICE_SECRET_POLICY[service]]
  if (!isSafeServiceName(service)) return []
  return [
    `ADMIN_TO_${service.toUpperCase()}_KEY`,
    'DOMAIN_TO_ADMIN_KEY',
    'DOMAIN_TO_NOTIFIER_KEY',
    'JWT_PUBLIC_KEY',
  ]
}

function configuredDomainDirectory(options = {}) {
  const configured = options.domainService ?? provisioningOptions('admin').domainService
  if (typeof configured !== 'string') return null
  const directory = configured.replaceAll('-', '_')
  return isSafeServiceName(directory) ? directory : null
}

/**
 * A normal rotation bundle is deliberately topology-wide. Cloudflare does
 * not reveal secret values, so a per-Worker partial bundle cannot prove that a
 * newly supplied key is distinct from a key already assigned to another
 * Worker. The bootstrap workflow performs the same check over its complete
 * environment-secret set in shell before creating any Worker.
 */
export function requiredTopologyProductionSecretNames(options = {}) {
  const domainService = configuredDomainDirectory(options)
  const domainNames = domainService
    ? requiredProductionSecretNames(domainService, options)
    : [
        'ADMIN_TO_EXAMPLE_SERVICE_KEY',
        'DOMAIN_TO_ADMIN_KEY',
        'DOMAIN_TO_NOTIFIER_KEY',
        'JWT_PUBLIC_KEY',
      ]
  return [
    ...new Set([
      ...requiredProductionSecretNames('admin', options),
      ...domainNames,
      ...requiredProductionSecretNames('notifier', options),
      ...requiredProductionSecretNames('ops', options),
    ]),
  ]
}

export function validateProductionSecretBundle(values, options = {}) {
  const expected = new Set(requiredTopologyProductionSecretNames(options))
  const optional = new Set(['BACKUP_SIGNING_PUBLIC_KEY'])
  const actual = Object.keys(values ?? {})
  return [
    ...[...expected]
      .filter((name) => typeof values?.[name] !== 'string' || values[name].trim() === '')
      .map((name) => `secret bundle is missing required values: ${name}`),
    ...actual
      .filter((name) => !expected.has(name) && !optional.has(name))
      .map((name) => `secret bundle contains an unexpected value: ${name}`),
  ]
}

export function targetProductionSecretValues(service, values, options = {}) {
  const required = new Set(requiredProductionSecretNames(service, options))
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(
      ([name, value]) =>
        typeof value === 'string' &&
        required.has(name) &&
        isAllowedProductionSecret(service, name, options),
    ),
  )
}

function normalizedPem(value) {
  const trimmed = value.trim()
  const match = trimmed.match(/^-----BEGIN ([A-Z ]+KEY)-----([A-Za-z0-9+/=\r\n]+)-----END \1-----$/)
  if (!match) return trimmed
  const payload = match[2].replace(/\s+/g, '')
  return `-----BEGIN ${match[1]}-----\n${payload.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${match[1]}-----\n`
}

function publicFingerprint(value, privateKey = false, label = 'RSA key') {
  const pem = normalizedPem(value)
  if (!privateKey) {
    const pemLabel = pem.match(/^-----BEGIN ([A-Z ]+KEY)-----/)?.[1]
    if (pemLabel !== 'PUBLIC KEY' && pemLabel !== 'RSA PUBLIC KEY') {
      throw new Error(`${label} must contain a public-key PEM`)
    }
  }
  const key = privateKey ? createPrivateKey(pem) : createPublicKey(pem)
  const publicKey = privateKey ? createPublicKey(key) : key
  if (publicKey.asymmetricKeyType !== 'rsa') throw new Error('JWT key must be RSA')
  if (publicKey.asymmetricKeyDetails?.modulusLength < 2048) {
    throw new Error('JWT RSA key must be at least 2048 bits')
  }
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex')
}

function pemKind(value) {
  const label = normalizedPem(value).match(/^-----BEGIN ([A-Z ]+KEY)-----/)?.[1]
  if (!label) return null
  if (label.includes('PRIVATE')) return 'private'
  if (label === 'PUBLIC KEY' || label === 'RSA PUBLIC KEY') return 'public'
  return null
}

function semanticFingerprint(name, value) {
  const kind = pemKind(value)
  if (!kind) return null
  const expectedKind = name.includes('PUBLIC')
    ? 'public'
    : name.includes('PRIVATE')
      ? 'private'
      : null
  if (expectedKind && kind !== expectedKind) return null
  return publicFingerprint(value, kind === 'private', name)
}

function isKnownDevelopmentValue(value) {
  const trimmed = value.trim()
  return KNOWN_DEVELOPMENT_VALUES.has(trimmed) || /^(?:dev|e2e|test)(?:[-_]|$)/i.test(trimmed)
}

function validateProductionSecretMaterial(values) {
  const violations = []
  const entries = Object.entries(values ?? {}).filter(([, value]) => typeof value === 'string')
  const fingerprints = new Map()
  const rsaFingerprints = new Map()
  let privateFingerprint
  let publicFingerprintValue
  let backupPrivateFingerprint
  let backupPublicFingerprintValue

  for (const [name, value] of entries) {
    const trimmed = value.trim()
    const looksLikePem = /^-----BEGIN [A-Z ]+KEY-----/.test(normalizedPem(trimmed))
    if (!trimmed) {
      violations.push(`${name} must not be empty`)
      continue
    }
    if (isKnownDevelopmentValue(trimmed)) {
      violations.push(`${name} is a published development/template value`)
    }

    if (name !== 'JWT_PUBLIC_KEY') {
      if (new TextEncoder().encode(trimmed).length < MIN_KEY_BYTES) {
        if (name.endsWith('_KEY') || name.endsWith('_TOKEN') || name === 'AUTH_PEPPER') {
          violations.push(`${name} must be at least ${MIN_KEY_BYTES} bytes`)
        }
      }
      if (
        (name.endsWith('_KEY') || name.endsWith('_TOKEN') || name === 'AUTH_PEPPER') &&
        !name.startsWith('JWT_') &&
        !looksLikePem
      ) {
        if (
          [...trimmed].some((character) => {
            const codePoint = character.codePointAt(0) ?? 0
            return codePoint <= 0x1f || codePoint === 0x7f
          })
        ) {
          violations.push(`${name} must not contain control characters`)
        }
      }
    }

    // Raw equality catches opaque caller keys and exact PEM reuse. It is kept
    // separate from the RSA fingerprint below because formatting a PEM can
    // change its bytes without changing the key it represents.
    const rawFingerprint = createHash('sha256').update(trimmed).digest('hex')
    const previous = fingerprints.get(rawFingerprint)
    if (previous) violations.push(`${name} duplicates the caller key ${previous}`)
    else fingerprints.set(rawFingerprint, name)

    if (name === 'AUTH_PEPPER' && new TextEncoder().encode(trimmed).length < MIN_KEY_BYTES) {
      violations.push(`AUTH_PEPPER must be at least ${MIN_KEY_BYTES} bytes`)
    }

    const mustBeRsaKey = new Set([
      'JWT_PRIVATE_KEY',
      'JWT_PUBLIC_KEY',
      'BACKUP_SIGNING_PRIVATE_KEY',
      'BACKUP_SIGNING_PUBLIC_KEY',
    ]).has(name)
    if (mustBeRsaKey || looksLikePem) {
      try {
        const semantic = semanticFingerprint(name, trimmed)
        if (!semantic) throw new Error('not an RSA PEM')
        rsaFingerprints.set(semantic, [...(rsaFingerprints.get(semantic) ?? []), name])
        if (semantic === KNOWN_TEST_PUBLIC_FINGERPRINT) {
          violations.push(`${name} is the committed test key`)
        }
        if (name === 'JWT_PRIVATE_KEY') privateFingerprint = semantic
        if (name === 'JWT_PUBLIC_KEY') publicFingerprintValue = semantic
        if (name === 'BACKUP_SIGNING_PRIVATE_KEY') backupPrivateFingerprint = semantic
        if (name === 'BACKUP_SIGNING_PUBLIC_KEY') backupPublicFingerprintValue = semantic
      } catch {
        const keyKind = name.includes('PUBLIC') ? 'public key' : 'private key'
        violations.push(`${name} is not a valid ${keyKind}`)
      }
    }
  }

  for (const names of rsaFingerprints.values()) {
    const uniqueNames = [...new Set(names)]
    if (uniqueNames.length < 2) continue
    const allowedJwtPair = new Set(['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'])
    const allowedBackupPair = new Set(['BACKUP_SIGNING_PRIVATE_KEY', 'BACKUP_SIGNING_PUBLIC_KEY'])
    const actual = new Set(uniqueNames)
    const isDedicatedPair =
      (actual.size === allowedJwtPair.size &&
        [...actual].every((name) => allowedJwtPair.has(name))) ||
      (actual.size === allowedBackupPair.size &&
        [...actual].every((name) => allowedBackupPair.has(name)))
    if (isDedicatedPair) continue
    const first = uniqueNames[0]
    for (const name of uniqueNames.slice(1)) {
      violations.push(`${name} reuses cryptographic key material from ${first}`)
    }
  }

  if (
    privateFingerprint &&
    publicFingerprintValue &&
    privateFingerprint !== publicFingerprintValue
  ) {
    violations.push('JWT key pair public/private keys do not match')
  }
  if (
    backupPrivateFingerprint &&
    backupPublicFingerprintValue &&
    backupPrivateFingerprint !== backupPublicFingerprintValue
  ) {
    violations.push('backup signing key pair public/private keys do not match')
  }
  return [...new Set(violations)]
}

function provisioningOptions(service) {
  if (service !== 'admin') return {}
  try {
    const config = parseJsonc(readFileSync(resolve(root, 'services/admin/wrangler.jsonc'), 'utf8'))
    return { domainService: effectiveValues(config).adminDomainService }
  } catch {
    return {}
  }
}

function fail(message) {
  console.error(`production secret provisioning blocked: ${message}`)
  process.exitCode = 1
}

export { isAllowedProductionSecret, validateProductionSecretMaterial }

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  fail(
    'local production secret writes are disabled; use a protected production workflow such as production-bootstrap.yml or an approved production workflow',
  )
}
