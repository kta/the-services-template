#!/usr/bin/env node

import { createPublicKey } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const MAX_CONFIG_BYTES = 1024 * 1024
const PLACEHOLDER_ID = /0{32}|00000000-0000-0000-0000-000000000000/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Production `vars` are public configuration. Keep the names explicit so a
// typo cannot silently become a plaintext secret, and so a future secret-like
// binding cannot bypass `wrangler secret put` merely by being added here.
const ALLOWED_PRODUCTION_VARS = {
  admin: new Set([
    'APP_ENV',
    'OPS_ALERT_EMAIL',
    'INVITE_BASE_URL',
    'DOMAIN_NOTIFICATION_TO',
    'AUTH_DEV_GRANT',
  ]),
  notifier: new Set([
    'APP_ENV',
    'MAIL_FROM',
    'DOMAIN_NOTIFICATION_TO',
    'OPS_ALERT_EMAIL',
    'INVITE_BASE_URL',
  ]),
  ops: new Set([
    'APP_ENV',
    'CF_ACCOUNT_ID',
    'ADMIN_DB_ID',
    'BACKUP_BUCKET_NAME',
    'OPS_ALERT_EMAIL',
    'BACKUP_SIGNING_PUBLIC_KEY',
  ]),
  domain: new Set(['APP_ENV', 'DOMAIN_NOTIFICATION_TO', 'AUTH_DEV_GRANT']),
}

class JsoncParser {
  constructor(source) {
    this.source = source
    this.offset = 0
  }

  parse() {
    this.skipIgnored()
    const value = this.parseValue('$')
    this.skipIgnored()
    if (this.offset !== this.source.length) this.fail('unexpected trailing content')
    return value
  }

  fail(message) {
    throw new Error(`${message} at offset ${this.offset}`)
  }

  skipIgnored() {
    while (this.offset < this.source.length) {
      const character = this.source[this.offset]
      if (/\s/.test(character)) {
        this.offset += 1
        continue
      }
      if (this.source.startsWith('//', this.offset)) {
        const newline = this.source.indexOf('\n', this.offset + 2)
        this.offset = newline === -1 ? this.source.length : newline + 1
        continue
      }
      if (this.source.startsWith('/*', this.offset)) {
        const end = this.source.indexOf('*/', this.offset + 2)
        if (end === -1) this.fail('unterminated block comment')
        this.offset = end + 2
        continue
      }
      return
    }
  }

  parseValue(path) {
    this.skipIgnored()
    const character = this.source[this.offset]
    if (character === '{') return this.parseObject(path)
    if (character === '[') return this.parseArray(path)
    if (character === '"') return this.parseString()
    if (this.source.startsWith('true', this.offset)) {
      this.offset += 4
      return true
    }
    if (this.source.startsWith('false', this.offset)) {
      this.offset += 5
      return false
    }
    if (this.source.startsWith('null', this.offset)) {
      this.offset += 4
      return null
    }
    const number = this.source
      .slice(this.offset)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number) {
      this.offset += number[0].length
      return Number(number[0])
    }
    this.fail(`invalid JSON value for ${path}`)
  }

  parseObject(path) {
    this.offset += 1
    const value = Object.create(null)
    const keys = new Set()
    this.skipIgnored()
    if (this.source[this.offset] === '}') {
      this.offset += 1
      return value
    }
    while (this.offset < this.source.length) {
      this.skipIgnored()
      if (this.source[this.offset] !== '"') this.fail(`object key expected for ${path}`)
      const key = this.parseString()
      if (keys.has(key)) this.fail(`duplicate key ${path}.${key}`)
      keys.add(key)
      this.skipIgnored()
      if (this.source[this.offset] !== ':') this.fail(`colon expected after ${path}.${key}`)
      this.offset += 1
      value[key] = this.parseValue(`${path}.${key}`)
      this.skipIgnored()
      if (this.source[this.offset] === '}') {
        this.offset += 1
        return value
      }
      if (this.source[this.offset] !== ',') this.fail(`comma expected after ${path}.${key}`)
      this.offset += 1
      this.skipIgnored()
      if (this.source[this.offset] === '}') {
        this.offset += 1
        return value
      }
    }
    this.fail(`unterminated object ${path}`)
  }

  parseArray(path) {
    this.offset += 1
    const value = []
    this.skipIgnored()
    if (this.source[this.offset] === ']') {
      this.offset += 1
      return value
    }
    while (this.offset < this.source.length) {
      value.push(this.parseValue(`${path}[${value.length}]`))
      this.skipIgnored()
      if (this.source[this.offset] === ']') {
        this.offset += 1
        return value
      }
      if (this.source[this.offset] !== ',') this.fail(`comma expected in ${path}`)
      this.offset += 1
      this.skipIgnored()
      if (this.source[this.offset] === ']') {
        this.offset += 1
        return value
      }
    }
    this.fail(`unterminated array ${path}`)
  }

  parseString() {
    const start = this.offset
    this.offset += 1
    while (this.offset < this.source.length) {
      const character = this.source[this.offset]
      if (character === '\\') {
        this.offset += 2
        continue
      }
      this.offset += 1
      if (character === '"') return JSON.parse(this.source.slice(start, this.offset))
    }
    this.fail('unterminated string')
  }
}

export function parseJsonc(source) {
  return new JsoncParser(source).parse()
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function firstBinding(config, collection, binding) {
  const entries = Array.isArray(config[collection]) ? config[collection] : []
  return asObject(entries.find((entry) => asObject(entry)?.binding === binding))
}

function compareExactServiceCollection(label, expected, actual, violations) {
  const counts = new Map()
  for (const service of actual) counts.set(service, (counts.get(service) ?? 0) + 1)
  const missing = []
  for (const service of expected) {
    const count = counts.get(service) ?? 0
    if (count === 0) missing.push(service)
    else counts.set(service, count - 1)
  }
  const extra = []
  for (const [service, count] of counts) {
    for (let index = 0; index < count; index += 1) extra.push(service)
  }
  if (missing.length || extra.length) {
    const parts = []
    if (missing.length) parts.push(`missing ${missing.join(', ')}`)
    if (extra.length) parts.push(`extra ${extra.join(', ')}`)
    violations.push(
      `${label} must exactly match the deployable domain catalog: ${parts.join('; ')}`,
    )
  }
}

function expectedDeployableDomainsFromCatalog(source) {
  const catalog = JSON.parse(source)
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('service-catalog.json must contain an object')
  }
  if (!Array.isArray(catalog.services)) {
    throw new Error('service-catalog.json must contain a services array')
  }
  const directories = new Set()
  const expected = []
  for (const [index, entry] of catalog.services.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`service-catalog.json services[${index}] must be an object`)
    }
    const { directory, package: packageName, deployable } = entry
    if (
      typeof directory !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(directory) ||
      packageName !== `@app/${directory}` ||
      typeof deployable !== 'boolean' ||
      directories.has(directory)
    ) {
      throw new Error(`service-catalog.json services[${index}] has invalid identity`)
    }
    directories.add(directory)
    if (deployable && directory !== 'admin') expected.push(directory)
  }
  return expected
}

export function effectiveValues(config) {
  const vars = asObject(config.vars) ?? Object.create(null)
  const d1 = firstBinding(config, 'd1_databases', 'DB')
  const dedupe = firstBinding(config, 'kv_namespaces', 'DEDUPE')
  const backups = firstBinding(config, 'r2_buckets', 'BACKUPS')
  const exampleService = firstBinding(config, 'services', 'EXAMPLE_SERVICE')
  return {
    appEnv: vars.APP_ENV,
    adminDatabaseId: d1?.database_id ?? config.database_id,
    databaseName: d1?.database_name ?? config.database_name,
    adminDomainService: exampleService?.service ?? config.service,
    domainNotifierService: firstBinding(config, 'services', 'NOTIFIER')?.service,
    domainConfigName: config.name,
    workerName: config.name,
    notifierDedupeId: dedupe?.id ?? config.id,
    opsBucketName: backups?.bucket_name ?? config.bucket_name,
    opsAdminDatabaseId: vars.ADMIN_DB_ID ?? config.ADMIN_DB_ID,
    backupBucketName: vars.BACKUP_BUCKET_NAME ?? config.BACKUP_BUCKET_NAME,
    opsAccountId: vars.CF_ACCOUNT_ID ?? config.CF_ACCOUNT_ID,
    opsAlertEmail: vars.OPS_ALERT_EMAIL ?? config.OPS_ALERT_EMAIL,
    mailFrom: vars.MAIL_FROM ?? config.MAIL_FROM,
    domainNotificationTo: vars.DOMAIN_NOTIFICATION_TO ?? config.DOMAIN_NOTIFICATION_TO,
    inviteBaseUrl: vars.INVITE_BASE_URL ?? config.INVITE_BASE_URL,
  }
}

function hasOwn(value, key) {
  return value && typeof value === 'object' && Object.hasOwn(value, key)
}

function rejectDevelopmentSettings(config, service, violations) {
  const vars = asObject(config.vars) ?? Object.create(null)
  const requiredSecrets = Array.isArray(asObject(config.secrets)?.required)
    ? config.secrets.required
    : []
  if (
    String(vars.AUTH_DEV_GRANT ?? '')
      .trim()
      .toLowerCase() === 'true'
  ) {
    violations.push(`${service} AUTH_DEV_GRANT must be false in production`)
  }
  if (hasOwn(vars, 'AUTH_DEV_PRIVATE_KEY') || requiredSecrets.includes('AUTH_DEV_PRIVATE_KEY')) {
    violations.push(`${service} AUTH_DEV_PRIVATE_KEY must not be configured in production`)
  }
  if (
    String(vars.MAIL_DEV_LOG ?? '')
      .trim()
      .toLowerCase() === 'true'
  ) {
    violations.push(`${service} MAIL_DEV_LOG must be false in production`)
  }
}

function rejectSecretLikeProductionVars(config, service, violations, options = {}) {
  const vars = asObject(config.vars) ?? Object.create(null)
  const allowed = new Set(ALLOWED_PRODUCTION_VARS[service] ?? ALLOWED_PRODUCTION_VARS.domain)
  for (const name of options.allowedOpsDatabaseVars ?? []) allowed.add(name)
  for (const [name, value] of Object.entries(vars)) {
    if (!allowed.has(name)) {
      violations.push(
        `${service} vars.${name} is secret-like or not an approved public production var`,
      )
      continue
    }
    if (
      (name !== 'BACKUP_SIGNING_PUBLIC_KEY' &&
        /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|PEPPER|INTERNAL_KEY|_KEY$)/.test(name)) ||
      (typeof value === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value))
    ) {
      violations.push(`${service} vars.${name} is secret-like; use wrangler secret put`)
    }
  }
}

function requireNonPlaceholder(value, label, violations) {
  if (!asString(value) || PLACEHOLDER_ID.test(asString(value))) {
    violations.push(`${label} is still a template placeholder`)
  }
}

function requireNonEmpty(value, label, violations) {
  if (!asString(value)) violations.push(`${label} must be set`)
}

function requireEmail(value, label, violations) {
  const normalized = asString(value)
  if (
    !normalized ||
    new TextEncoder().encode(normalized).length > 320 ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    violations.push(`${label} must be a valid operational email`)
  }
}

function requireHttpsOrigin(value, label, violations) {
  try {
    const url = new URL(asString(value))
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error('not a canonical HTTPS origin')
    }
  } catch {
    violations.push(`${label} must be a canonical HTTPS origin`)
  }
}

function requireRsaPublicKey(value, label, violations) {
  const pem = asString(value)
  if (
    !/^-----BEGIN (?:PUBLIC KEY|RSA PUBLIC KEY)-----[\s\S]+-----END (?:PUBLIC KEY|RSA PUBLIC KEY)-----$/.test(
      pem,
    )
  ) {
    violations.push(`${label} must be a configured public-key PEM`)
    return
  }
  try {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) {
      throw new Error('key is not a 2048-bit RSA key')
    }
  } catch {
    violations.push(`${label} must be an RSA public key of at least 2048 bits`)
  }
}

export function validateProductionConfig(source, service, environment = {}, options = {}) {
  const violations = []
  let config
  try {
    if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
      return ['configuration file is too large']
    }
    config = asObject(parseJsonc(source))
    if (!config) return ['configuration root must be a JSON object']
  } catch (error) {
    return [`config is invalid JSONC: ${error instanceof Error ? error.message : 'parse error'}`]
  }

  const values = effectiveValues(config)
  rejectDevelopmentSettings(config, service, violations)
  rejectSecretLikeProductionVars(config, service, violations, options)
  if (options.requireWorkerName) {
    const expectedWorkerName =
      service === 'example_service' ? 'example-service' : service.replaceAll('_', '-')
    if (values.workerName !== expectedWorkerName) {
      violations.push(`${service} Worker name must be exactly ${expectedWorkerName}`)
    }
    const runtimeAccountId = asString(environment.CLOUDFLARE_ACCOUNT_ID)
    if (!runtimeAccountId) {
      violations.push('CLOUDFLARE_ACCOUNT_ID is required for a production command')
    } else if (options.reviewedAccountId && runtimeAccountId !== options.reviewedAccountId) {
      violations.push('CLOUDFLARE_ACCOUNT_ID must match the reviewed ops account')
    }
  }
  switch (service) {
    case 'admin':
      requireNonPlaceholder(values.adminDatabaseId, 'admin database_id', violations)
      if (Array.isArray(options.expectedDomainServices)) {
        const actualDomainServices = (Array.isArray(config.services) ? config.services : [])
          .filter((entry) => asObject(entry)?.binding !== 'NOTIFIER')
          .map((entry) => asString(asObject(entry)?.service).replaceAll('-', '_') || '<invalid>')
        compareExactServiceCollection(
          'admin production domain bindings',
          options.expectedDomainServices,
          actualDomainServices,
          violations,
        )
      } else if (
        asString(values.adminDomainService) === 'example-service' ||
        !asString(values.adminDomainService)
      ) {
        violations.push('admin EXAMPLE_SERVICE binding still targets the scaffold example-service')
      }
      if (asString(values.appEnv) !== 'production') {
        violations.push('admin APP_ENV must be production')
      }
      requireEmail(values.opsAlertEmail, 'admin OPS_ALERT_EMAIL', violations)
      requireHttpsOrigin(values.inviteBaseUrl, 'admin INVITE_BASE_URL', violations)
      break
    case 'notifier':
      requireNonPlaceholder(values.notifierDedupeId, 'notifier DEDUPE id', violations)
      requireEmail(values.mailFrom, 'notifier MAIL_FROM', violations)
      requireEmail(values.domainNotificationTo, 'notifier DOMAIN_NOTIFICATION_TO', violations)
      requireEmail(values.opsAlertEmail, 'notifier OPS_ALERT_EMAIL', violations)
      requireHttpsOrigin(values.inviteBaseUrl, 'notifier INVITE_BASE_URL', violations)
      if (asString(values.appEnv) !== 'production') {
        violations.push('notifier APP_ENV must be production')
      }
      break
    case 'ops': {
      requireNonEmpty(values.opsBucketName, 'ops BACKUPS bucket_name', violations)
      requireNonEmpty(values.backupBucketName, 'ops BACKUP_BUCKET_NAME', violations)
      if (asString(values.opsBucketName) === 'app-backups') {
        violations.push('ops BACKUPS bucket_name must be renamed from the template default')
      }
      if (
        asString(values.backupBucketName) &&
        asString(values.opsBucketName) &&
        asString(values.backupBucketName) !== asString(values.opsBucketName)
      ) {
        violations.push('ops BACKUP_BUCKET_NAME must match the BACKUPS bucket_name')
      }
      requireNonPlaceholder(values.opsAdminDatabaseId, 'ops ADMIN_DB_ID', violations)
      requireNonEmpty(values.opsAccountId, 'ops CF_ACCOUNT_ID', violations)
      requireRsaPublicKey(
        asObject(config.vars)?.BACKUP_SIGNING_PUBLIC_KEY,
        'ops BACKUP_SIGNING_PUBLIC_KEY',
        violations,
      )
      if (asString(values.opsAccountId) === 'dev-account-id') {
        violations.push('ops CF_ACCOUNT_ID must be replaced with the real account id')
      }
      const runtimeAccountId = asString(environment.CLOUDFLARE_ACCOUNT_ID)
      if (runtimeAccountId && runtimeAccountId !== asString(values.opsAccountId)) {
        violations.push('ops CF_ACCOUNT_ID must match CLOUDFLARE_ACCOUNT_ID used by the deploy job')
      }
      if (options.reviewedDatabaseIds) {
        const reviewedDatabaseIds = options.reviewedDatabaseIds
        const vars = asObject(config.vars) ?? Object.create(null)
        for (const [name, value] of Object.entries(vars)) {
          const match = name.match(/^([A-Z][A-Z0-9_]*)_DB_ID$/)
          if (!match) continue
          const serviceName = match[1].toLowerCase()
          const reviewedId = asString(reviewedDatabaseIds[serviceName])
          if (!reviewedId) {
            violations.push(`ops ${name} must map to a reviewed ${serviceName} D1 database_id`)
          } else if (asString(value).toLowerCase() !== reviewedId.toLowerCase()) {
            violations.push(`ops ${name} must match services/${serviceName} D1 database_id`)
          }
        }
      }
      if (asString(values.appEnv) !== 'production') {
        violations.push('ops APP_ENV must be production')
      }
      requireEmail(values.opsAlertEmail, 'ops OPS_ALERT_EMAIL', violations)
      break
    }
    default:
      if (!/^[a-z][a-z0-9_]*$/.test(service)) {
        throw new Error(`unknown production service: ${service}`)
      }
      requireNonPlaceholder(values.adminDatabaseId, `${service} database_id`, violations)
      if (
        asString(values.adminDomainService) === 'example-service' ||
        asString(values.domainConfigName) === 'example-service'
      ) {
        violations.push(`${service} config is still the scaffold example-service`)
      }
      if (asString(values.appEnv) !== 'production') {
        violations.push(`${service} APP_ENV must be production`)
      }
      if (asString(values.domainNotifierService) !== 'notifier') {
        violations.push(`${service} notifier service binding must be exactly notifier`)
      }
      if (asString(values.domainNotificationTo))
        requireEmail(values.domainNotificationTo, `${service} DOMAIN_NOTIFICATION_TO`, violations)
      break
  }
  return violations
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = process.argv[2]
  if (!service) {
    console.error('usage: check-production-config.mjs <admin|domain|notifier|ops>')
    process.exitCode = 2
  } else {
    const expectedDomainServices = expectedDeployableDomainsFromCatalog(
      await readFile(join(root, 'service-catalog.json'), 'utf8'),
    )
    const configPath = join(root, `services/${service}/wrangler.jsonc`)
    const opsConfig = parseJsonc(await readFile(join(root, 'services/ops/wrangler.jsonc'), 'utf8'))
    const reviewedDatabaseIds = {}
    const serviceEntries = await readdir(join(root, 'services'), { withFileTypes: true })
    for (const entry of serviceEntries) {
      if (!entry.isDirectory() || entry.name === 'notifier' || entry.name === 'ops') continue
      try {
        const config = parseJsonc(
          await readFile(join(root, 'services', entry.name, 'wrangler.jsonc'), 'utf8'),
        )
        const databaseId = asString(effectiveValues(config).adminDatabaseId)
        if (databaseId) reviewedDatabaseIds[entry.name] = databaseId
      } catch {
        // The target's own config validation reports the useful error. Keep
        // this map fail-closed so ops cannot bind an unreviewed D1 by name.
      }
    }
    const allowedOpsDatabaseVars = Object.keys(reviewedDatabaseIds).map(
      (name) => `${name.toUpperCase()}_DB_ID`,
    )
    const violations = validateProductionConfig(
      await readFile(configPath, 'utf8'),
      service,
      process.env,
      {
        requireWorkerName: true,
        reviewedAccountId: asString(effectiveValues(opsConfig).opsAccountId),
        allowedOpsDatabaseVars,
        reviewedDatabaseIds,
        expectedDomainServices,
      },
    )
    if (violations.length > 0) {
      console.error(`production config blocked for ${service}:`)
      for (const violation of violations) console.error(`- ${violation}`)
      process.exitCode = 1
    } else {
      console.log(`production config for ${service}: ok`)
    }
  }
}
