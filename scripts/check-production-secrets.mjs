#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveValues, parseJsonc } from './check-production-config.mjs'
import {
  productionCloudflareEnvironment,
  productionStaticEnvironment,
} from './production-environment.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i
const WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

const PRODUCTION_SECRET_POLICY = {
  admin: [
    'DOMAIN_TO_ADMIN_KEY',
    'ADMIN_TO_NOTIFIER_KEY',
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'AUTH_PEPPER',
  ],
  notifier: [
    'ADMIN_TO_NOTIFIER_KEY',
    'DOMAIN_TO_NOTIFIER_KEY',
    'OPS_TO_NOTIFIER_KEY',
    'RESEND_API_KEY',
  ],
  ops: [
    'OPS_TO_NOTIFIER_KEY',
    'D1_EXPORT_API_TOKEN',
    'R2_POLICY_CHECK_API_TOKEN',
    'BACKUP_SIGNING_PRIVATE_KEY',
  ],
}

function domainSecretName(domainService) {
  if (typeof domainService !== 'string') return null
  const suffix = domainService.replaceAll('-', '_').toUpperCase()
  return /^[A-Z][A-Z0-9_]*$/.test(suffix) ? `ADMIN_TO_${suffix}_KEY` : null
}

// The example service is a local scaffold, never a production target. Keep
// this decision separate from the name-policy helper so unit tests can still
// exercise a copied domain's allowlist without accidentally authorizing a
// real remote write to the scaffold.
export function isProductionSecretProvisioningService(service) {
  return (
    typeof service === 'string' &&
    /^[a-z][a-z0-9_]*$/.test(service) &&
    service !== 'example_service'
  )
}

export function productionWorkerSecretsUrl(accountId, workerName) {
  if (!ACCOUNT_ID_PATTERN.test(accountId) || !WORKER_NAME_PATTERN.test(workerName)) {
    throw new Error('Cloudflare Worker secret endpoint identifiers are invalid')
  }
  return `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/secrets`
}

export function parseProductionSecretResponse(body) {
  if (body?.success !== true || !Array.isArray(body.result)) {
    throw new Error('Cloudflare Worker secret response is invalid')
  }
  return body.result
}

export function productionSecretGuard(args) {
  if (!Array.isArray(args) || args.length > 1) {
    throw new Error('remote secret inspection accepts one reviewed mode')
  }
  if (args.length === 0) {
    return { guardScript: 'require-production-provisioning.mjs', allowMissingWorker: false }
  }
  if (args[0] === '--deploy') {
    return { guardScript: 'require-production-deploy.mjs', allowMissingWorker: false }
  }
  if (args[0] === '--allow-missing-worker') {
    return { guardScript: 'require-production-provisioning.mjs', allowMissingWorker: true }
  }
  throw new Error('remote secret inspection accepts one reviewed mode')
}

async function fetchProductionSecretEntries(accountId, workerName, apiToken, fetchImpl = fetch) {
  const response = await fetchImpl(productionWorkerSecretsUrl(accountId, workerName), {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiToken ?? ''}`,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 404) {
    const error = new Error('Cloudflare Worker was not found')
    error.code = 'WORKER_NOT_FOUND'
    throw error
  }
  if (!response.ok) throw new Error('Cloudflare Worker secret lookup failed')
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error('Cloudflare Worker secret response is invalid')
  }
  return parseProductionSecretResponse(body)
}

function expectedProductionSecretNames(service, options = {}) {
  const expected = PRODUCTION_SECRET_POLICY[service]
  if (expected && service !== 'admin') return expected
  if (service !== 'admin' && !expected) {
    const domainSecret = domainSecretName(service)
    if (!domainSecret) throw new Error(`unknown production service: ${service}`)
    // A copied domain's config is repository input and must not be allowed to
    // widen the remote secret policy. Its target contract is fixed by the
    // service directory name: the admin caller key, the live-session caller
    // key, the notifier caller key, and the public JWT half. Private/shared
    // legacy names are rejected below.
    return [domainSecret, 'DOMAIN_TO_ADMIN_KEY', 'DOMAIN_TO_NOTIFIER_KEY', 'JWT_PUBLIC_KEY']
  }
  const configuredDomainSecrets = Array.isArray(options.domainSecrets)
    ? options.domainSecrets
    : [domainSecretName(options.domainService)].filter(Boolean)
  return [...expected.slice(0, 1), ...configuredDomainSecrets, ...expected.slice(1)]
}

function configuredAdminDomainSecrets(config) {
  const serialized = config?.vars?.ADMIN_DOMAIN_IDENTITIES
  if (typeof serialized !== 'string') {
    throw new Error('ADMIN_DOMAIN_IDENTITIES must be configured')
  }
  const identities = JSON.parse(serialized)
  if (!Array.isArray(identities)) throw new Error('ADMIN_DOMAIN_IDENTITIES must be an array')
  return identities.map((identity) => {
    const expected = domainSecretName(identity?.directory)
    if (
      !expected ||
      identity?.binding !== identity.directory.toUpperCase() ||
      identity?.secret !== expected ||
      Object.keys(identity).sort().join('|') !== 'binding|directory|secret'
    ) {
      throw new Error('ADMIN_DOMAIN_IDENTITIES contains an invalid identity')
    }
    return identity.secret
  })
}

/** Validate names only; secret values are intentionally never read or printed. */
export function validateProductionSecretNames(service, entries, options = {}) {
  const expected = expectedProductionSecretNames(service, options)
  if (!Array.isArray(entries)) {
    return { missing: expected, unexpected: ['<invalid secret response>'] }
  }
  const names = []
  const malformed = []
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name
    if (typeof name !== 'string') {
      malformed.push('<invalid secret entry>')
      continue
    }
    names.push(name)
  }
  const actual = new Set(names)
  const expectedSet = new Set(expected)
  const forbiddenSecrets = new Set(['JWT_SECRET', 'INTERNAL_KEY'])
  if (service !== 'admin') forbiddenSecrets.add('JWT_PRIVATE_KEY')
  const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index)
  return {
    missing: expected.filter((name) => !actual.has(name)),
    unexpected: [
      ...new Set([
        ...malformed,
        ...names.filter((name) => !expectedSet.has(name) || forbiddenSecrets.has(name)),
        ...duplicateNames.filter((name) => expectedSet.has(name)),
      ]),
    ],
  }
}

function fail(message) {
  console.error(`production secrets blocked: ${message}`)
  process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [service, ...args] = process.argv.slice(2)
  let guard
  try {
    guard = productionSecretGuard(args)
  } catch {
    guard = undefined
  }
  if (!isProductionSecretProvisioningService(service) || !guard) {
    fail('usage: check-production-secrets.mjs <service> [--deploy|--allow-missing-worker]')
  } else {
    try {
      // This helper is also a direct CLI entry point. Establish the reviewed
      // checkout boundary without giving its code a Cloudflare credential.
      const { execFileSync } = await import('node:child_process')
      execFileSync(process.execPath, [resolve(root, `scripts/${guard.guardScript}`)], {
        cwd: root,
        stdio: 'inherit',
        env: productionStaticEnvironment(process.env),
      })
      const config = parseJsonc(
        await readFile(resolve(root, `services/${service}/wrangler.jsonc`), 'utf8'),
      )
      const options =
        service === 'admin'
          ? {
              domainSecrets: configuredAdminDomainSecrets(config),
            }
          : {}
      const opsConfig = parseJsonc(
        await readFile(resolve(root, 'services/ops/wrangler.jsonc'), 'utf8'),
      )
      const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim()
      const reviewedAccountId = String(effectiveValues(opsConfig).opsAccountId ?? '').trim()
      if (!ACCOUNT_ID_PATTERN.test(accountId) || accountId !== reviewedAccountId) {
        throw new Error('Cloudflare account does not match the reviewed ops account')
      }
      const workerName = String(effectiveValues(config).workerName ?? '').trim()
      const childEnv = productionCloudflareEnvironment(process.env)
      const entries = await fetchProductionSecretEntries(
        accountId,
        workerName,
        childEnv.CLOUDFLARE_API_TOKEN,
        fetch,
      )
      const result = validateProductionSecretNames(service, entries, options)
      if (result.unexpected.length || (!guard.allowMissingWorker && result.missing.length)) {
        fail(
          `${service} secret names do not match policy (missing: ${result.missing.join(', ') || 'none'}; unexpected: ${result.unexpected.join(', ') || 'none'})`,
        )
      } else {
        console.log(`production secret names for ${service}: ok`)
      }
    } catch (error) {
      if (guard.allowMissingWorker && error?.code === 'WORKER_NOT_FOUND') {
        console.log(
          `production secret names for ${service}: Worker not found; bootstrap may create it`,
        )
      } else {
        // Do not expose Wrangler's response: it can contain account/project data.
        fail('unable to inspect remote secret names')
      }
    }
  }
}
