#!/usr/bin/env node

import { createPublicKey } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveValues, parseJsonc } from './check-production-config.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const KV_NAMESPACE_ID_PATTERN = /^[0-9a-f]{32}$/i
const DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/

function reviewedBackupSigningPublicKey(config) {
  const vars = config.vars && typeof config.vars === 'object' ? config.vars : {}
  const value = String(vars.BACKUP_SIGNING_PUBLIC_KEY ?? '').trim()
  if (
    !/^-----BEGIN (?:PUBLIC KEY|RSA PUBLIC KEY)-----[\s\S]+-----END (?:PUBLIC KEY|RSA PUBLIC KEY)-----$/.test(
      value,
    )
  ) {
    throw new Error('ops BACKUP_SIGNING_PUBLIC_KEY must be a public-key PEM')
  }
  try {
    const key = createPublicKey(value)
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) {
      throw new Error('not a 2048-bit RSA public key')
    }
  } catch {
    throw new Error('ops BACKUP_SIGNING_PUBLIC_KEY must be an RSA public key of at least 2048 bits')
  }
  return value
}

function serviceDatabase(rootDir, service) {
  const config = parseJsonc(
    readFileSync(join(rootDir, `services/${service}/wrangler.jsonc`), 'utf8'),
  )
  const values = effectiveValues(config)
  const databaseId = String(values.adminDatabaseId ?? '').trim()
  const databaseName = String(values.databaseName ?? '').trim()
  if (!DATABASE_ID_PATTERN.test(databaseId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(databaseId)) {
    throw new Error(`${service} D1 database_id must be a concrete UUID`)
  }
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(`${service} D1 database_name is invalid`)
  }
  return { service, databaseId, databaseName }
}

function reviewedDatabaseIdentities(rootDir, opsConfig) {
  const vars = opsConfig.vars && typeof opsConfig.vars === 'object' ? opsConfig.vars : {}
  const identities = []
  for (const [name, configuredValue] of Object.entries(vars)) {
    const match = name.match(/^([A-Z][A-Z0-9_]*)_DB_ID$/)
    if (!match) continue
    const service = match[1].toLowerCase()
    const configuredId = String(configuredValue ?? '').trim()
    const identity = serviceDatabase(rootDir, service)
    if (identity.databaseId.toLowerCase() !== configuredId.toLowerCase()) {
      throw new Error(`ops ${name} must match services/${service} D1 database_id`)
    }
    identities.push(identity)
  }
  if (identities.length === 0) {
    throw new Error('ops must declare at least one reviewed *_DB_ID target')
  }
  return identities.sort((left, right) => left.service.localeCompare(right.service))
}

function notifierDedupeIdentity(rootDir) {
  const config = parseJsonc(readFileSync(join(rootDir, 'services/notifier/wrangler.jsonc'), 'utf8'))
  const id = String(effectiveValues(config).notifierDedupeId ?? '').trim()
  if (!KV_NAMESPACE_ID_PATTERN.test(id) || /^0{32}$/i.test(id)) {
    throw new Error('notifier DEDUPE namespace id must be a concrete KV namespace id')
  }
  return id
}

/**
 * Resolve only public Cloudflare resource identifiers before a workflow gets
 * production credentials. The credentialed job consumes these validated
 * outputs from its environment and uses fixed curl/Wrangler commands; it does
 * not execute repository JavaScript after the credential boundary.
 */
export function reviewedProductionResources(rootDir = root) {
  const config = parseJsonc(readFileSync(join(rootDir, 'services/ops/wrangler.jsonc'), 'utf8'))
  const values = effectiveValues(config)
  const accountId = String(values.opsAccountId ?? '').trim()
  const bucketName = String(values.opsBucketName ?? '').trim()
  const runtimeBucketName = String(values.backupBucketName ?? '').trim()
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error('ops CF_ACCOUNT_ID must be a concrete Cloudflare account id')
  }
  if (!BUCKET_NAME_PATTERN.test(bucketName)) {
    throw new Error('ops BACKUPS bucket_name is invalid')
  }
  if (runtimeBucketName !== bucketName) {
    throw new Error('ops BACKUP_BUCKET_NAME must match BACKUPS bucket_name')
  }
  const backupSigningPublicKey = reviewedBackupSigningPublicKey(config)
  return {
    accountId,
    bucketName,
    dedupeId: notifierDedupeIdentity(rootDir),
    backupSigningPublicKey,
    databaseIdentities: reviewedDatabaseIdentities(rootDir, config),
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  try {
    const { accountId, bucketName, dedupeId, backupSigningPublicKey, databaseIdentities } =
      reviewedProductionResources()
    const output = process.env.GITHUB_OUTPUT
    if (output) {
      appendFileSync(
        output,
        `account_id=${accountId}\nbucket_name=${bucketName}\ndedupe_id=${dedupeId}\nbackup_signing_public_key_b64=${Buffer.from(backupSigningPublicKey, 'utf8').toString('base64')}\ndatabase_identities=${JSON.stringify(databaseIdentities)}\n`,
        { mode: 0o600 },
      )
    }
    console.log('reviewed production resource identities: ok')
  } catch (error) {
    console.error(
      `production resource identity check blocked: ${error instanceof Error ? error.message : 'validation failed'}`,
    )
    process.exitCode = 1
  }
}
