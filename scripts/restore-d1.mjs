#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, createVerify } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveValues, parseJsonc } from './check-production-config.mjs'
import { productionEnvironment, productionStaticEnvironment } from './production-environment.mjs'
import { runProductionWrangler } from './production-wrangler.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CONFIRMATION = 'RESTORE_PRODUCTION'
const SERVICE_PATTERN = /^[a-z][a-z0-9_]*$/
const DATABASE_PATTERN = /^[a-z][a-z0-9_-]{0,62}-restore(?:-[a-z0-9]+)?$/
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const TARGET_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const BACKUP_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql$/
const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/i
const MAX_RESTORE_FILE_BYTES = 512 * 1024 * 1024
const MAX_RESTORE_MANIFEST_BYTES = 256 * 1024
const RESTORE_CHILD_TIMEOUT_MS = 15 * 60 * 1_000
export const TIME_TRAVEL_RETENTION_SECONDS = 7 * 24 * 60 * 60
const BACKUP_SIGNATURE_ALGORITHM = 'RSASSA-PKCS1-v1_5-SHA256'
const DESTRUCTIVE_OPERATIONS = new Set([
  'export-before-restore',
  'download-backup',
  'time-travel-restore',
  'create-restore-db',
  'import-backup',
  'upload-pre-restore',
])

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function serviceConfig(service) {
  if (!SERVICE_PATTERN.test(service)) throw new Error('invalid service name')
  const configPath = join(root, `services/${service}/wrangler.jsonc`)
  const config = asObject(parseJsonc(readFileSync(configPath, 'utf8')))
  if (!config) throw new Error('invalid service configuration')
  const database = Array.isArray(config.d1_databases)
    ? config.d1_databases.find((entry) => asObject(entry)?.binding === 'DB')
    : null
  const databaseName = asString(asObject(database)?.database_name)
  const databaseId = asString(asObject(database)?.database_id)
  if (
    service !== 'ops' &&
    (!DATABASE_ID_PATTERN.test(databaseId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(databaseId))
  ) {
    throw new Error('configured D1 database_id is not a reviewed UUID')
  }
  const values = effectiveValues(config)
  const bucket = asString(values.opsBucketName)
  const vars = asObject(config.vars) ?? Object.create(null)
  const databaseIds = Object.fromEntries(
    Object.entries(vars)
      .filter(([name, value]) => /^[A-Z][A-Z0-9_]*_DB_ID$/.test(name) && typeof value === 'string')
      .map(([name, value]) => [name.slice(0, -'_DB_ID'.length).toLowerCase(), asString(value)]),
  )
  const backupTargets = Object.keys(databaseIds).filter((name) => TARGET_PATTERN.test(name))
  const requiredSecretNames = Array.isArray(asObject(config.secrets)?.required)
    ? config.secrets.required.filter((name) => typeof name === 'string')
    : []
  return {
    configPath,
    config,
    databaseName,
    databaseId,
    accountId: asString(values.opsAccountId),
    bucket,
    backupTargets,
    databaseIds,
    signingPublicKey: asString(vars.BACKUP_SIGNING_PUBLIC_KEY),
    requiredSecretNames,
  }
}

export function validateRestoreConfirmation(value) {
  if (value !== CONFIRMATION) {
    throw new Error(`explicit confirmation ${CONFIRMATION} is required`)
  }
  return true
}

export function validateRestoreSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error('SHA-256 must be a 64-character hexadecimal digest')
  }
  return value.toLowerCase()
}

export function validateRestoreTimestamp(value, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs)) {
    throw new Error('restore timestamp validation clock is invalid')
  }
  const match = typeof value === 'string' ? value.match(TIMESTAMP_PATTERN) : null
  if (!match) {
    throw new Error('timestamp must be an RFC3339 UTC timestamp')
  }
  const parsed = Date.parse(value)
  const date = new Date(parsed)
  const milliseconds = match[7] ? Number(match[7].padEnd(3, '0')) : 0
  if (
    Number.isNaN(parsed) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== milliseconds
  ) {
    throw new Error('timestamp must be a real RFC3339 UTC timestamp')
  }
  if (parsed > nowMs) {
    throw new Error('timestamp must not be in the future')
  }
  if (parsed < nowMs - TIME_TRAVEL_RETENTION_SECONDS * 1_000) {
    throw new Error('timestamp is outside the 7-day retention window')
  }
  return true
}

export function validateRestoreCloudflareAccount(configuredAccountId, environment = {}) {
  const configured = asString(configuredAccountId)
  const runtime = asString(environment.CLOUDFLARE_ACCOUNT_ID)
  if (!configured || !runtime || configured !== runtime) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must exactly match the reviewed ops account')
  }
  return true
}

function publicKeyFingerprint(value) {
  const key = createPublicKey(asString(value))
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) {
    throw new Error('backup signing public key must be an RSA key of at least 2048 bits')
  }
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex')
}

/** The operator must verify the runtime restore key is the reviewed ops key. */
export function validateRestoreSigningPublicKey(configured, runtime) {
  const configuredValue = asString(configured)
  const runtimeValue = asString(runtime)
  if (!configuredValue || !runtimeValue) {
    throw new Error(
      'BACKUP_SIGNING_PUBLIC_KEY must be provided by the reviewed config and operator',
    )
  }
  try {
    if (publicKeyFingerprint(configuredValue) !== publicKeyFingerprint(runtimeValue)) {
      throw new Error('BACKUP_SIGNING_PUBLIC_KEY does not match the reviewed ops config')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not match')) throw error
    throw new Error('BACKUP_SIGNING_PUBLIC_KEY is not a valid reviewed RSA public key')
  }
  return true
}

/** Cross-check every ops REST-export database id against its reviewed Worker config. */
export function validateRestoreDatabaseBindings(configured, reviewed) {
  for (const [target, configuredId] of Object.entries(configured ?? {})) {
    const expected = asString(reviewed?.[target])
    if (!DATABASE_ID_PATTERN.test(asString(configuredId)) || !expected) {
      throw new Error(`ops ${target} database id is not a reviewed D1 binding`)
    }
    if (asString(configuredId).toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`ops ${target} database id does not match the reviewed D1 binding`)
    }
  }
  return true
}

export function validateRestoreDatabaseId(value) {
  if (typeof value !== 'string' || !DATABASE_ID_PATTERN.test(value.trim())) {
    throw new Error('restore database id must be a reviewed UUID')
  }
  return value.trim().toLowerCase()
}

export function validateRestoreDatabaseInfo(source, expectedId) {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('restore database info is invalid JSON')
  }
  const record = asObject(value)
  const databaseId = asString(record?.database_id ?? asObject(record?.result)?.database_id)
  if (!databaseId || databaseId.toLowerCase() !== validateRestoreDatabaseId(expectedId)) {
    throw new Error('restore database name does not resolve to the reviewed database id')
  }
  return true
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('manifest contains an unsupported value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
  return `{${entries.join(',')}}`
}

function verifyManifestSignature(record, expected) {
  const signature = asString(record.signature)
  const publicKeyPem = asString(expected.signingPublicKey)
  if (record.signatureAlgorithm !== BACKUP_SIGNATURE_ALGORITHM || !signature || !publicKeyPem) {
    throw new Error('backup manifest signature is missing')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new Error('backup manifest signature is invalid')
  }
  const unsigned = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'signature' && key !== 'signatureAlgorithm'),
  )
  let valid = false
  try {
    const verifier = createVerify('RSA-SHA256')
    verifier.update(canonicalJson(unsigned), 'utf8')
    verifier.end()
    const normalized = signature.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    valid = verifier.verify(createPublicKey(publicKeyPem), Buffer.from(padded, 'base64'))
  } catch {
    valid = false
  }
  if (!valid) throw new Error('backup manifest signature is invalid')
}

export function validateRestoreProvenance(manifest, target, accountId, databaseId, expected = {}) {
  const record = typeof manifest === 'string' ? JSON.parse(manifest) : manifest
  if (!asObject(record)) throw new Error('backup manifest signature is missing')
  verifyManifestSignature(record, expected)
  const targets = asObject(record)?.targets
  const candidate = asObject(targets)?.[target]
  const configuredAccount = asString(accountId)
  const configuredDatabase = asString(databaseId).toLowerCase()
  if (
    !candidate ||
    asString(candidate.accountId) !== configuredAccount ||
    asString(candidate.databaseId).toLowerCase() !== configuredDatabase ||
    typeof candidate.key !== 'string' ||
    typeof candidate.sha256 !== 'string'
  ) {
    throw new Error('backup manifest provenance does not match the reviewed target')
  }
  validateBackupKey(candidate.key, target)
  const sha256 = validateRestoreSha256(candidate.sha256)
  if (expected.key !== undefined && candidate.key !== expected.key) {
    throw new Error('backup manifest key does not match the requested object')
  }
  if (expected.sha256 !== undefined && sha256 !== validateRestoreSha256(expected.sha256)) {
    throw new Error('backup manifest digest does not match the requested object')
  }
  return { key: candidate.key, sha256 }
}

/**
 * A local manifest is operator evidence, not the source of truth. Compare it
 * with provenance fetched directly from the private R2 latest.json before an
 * import so a forged local JSON file cannot select a different backup.
 */
export function validateLocalManifestAgainstRemote(
  localManifest,
  target,
  accountId,
  databaseId,
  remoteProvenance,
  expected = {},
) {
  if (!remoteProvenance || typeof remoteProvenance !== 'object') {
    throw new Error('R2 manifest provenance is missing')
  }
  validateBackupKey(remoteProvenance.key, target)
  const remote = {
    key: remoteProvenance.key,
    sha256: validateRestoreSha256(remoteProvenance.sha256),
  }
  const local = validateRestoreProvenance(localManifest, target, accountId, databaseId, expected)
  if (local.key !== remote.key || local.sha256 !== remote.sha256) {
    throw new Error('local restore manifest does not match the R2 manifest')
  }
  return remote
}

export function validateRestoreDatabaseName(value, baseName) {
  if (typeof value !== 'string' || !DATABASE_PATTERN.test(value)) {
    throw new Error('database name must end in -restore')
  }
  if (baseName && value !== `${baseName}-restore` && !value.startsWith(`${baseName}-restore-`)) {
    throw new Error('database name must be derived from the configured source database')
  }
  return true
}

export function validateBackupKey(value, target = 'admin') {
  if (!TARGET_PATTERN.test(target)) throw new Error('backup key target is invalid')
  if (value === 'latest.json') return true
  if (typeof value !== 'string' || !value.startsWith(`${target}/`)) {
    throw new Error('backup key is outside the selected target')
  }
  if (!BACKUP_TIMESTAMP_PATTERN.test(value.slice(target.length + 1))) {
    throw new Error('backup key has an invalid generation name')
  }
  return true
}

function validatePreRestoreKey(value, service) {
  if (!SERVICE_PATTERN.test(service) || typeof value !== 'string') {
    throw new Error('pre-restore key is invalid')
  }
  const prefix = `pre-restore/${service}/`
  if (
    !value.startsWith(prefix) ||
    !/^[A-Za-z0-9._-]{1,160}\.sql$/.test(value.slice(prefix.length))
  ) {
    throw new Error('pre-restore key is outside the selected service')
  }
  return true
}

export function validateRestoreTarget(value, configuredTargets) {
  if (!TARGET_PATTERN.test(value) || !configuredTargets.includes(value)) {
    throw new Error('target is not a configured backup target')
  }
  return true
}

function validateOwnerOnlyTempParent(value, label) {
  const parent = resolve(value)
  const temporaryRoot = realpathSync(tmpdir())
  const relativeParent = relative(temporaryRoot, parent)
  if (relativeParent.startsWith('..') || isAbsolute(relativeParent)) {
    throw new Error(`${label} must stay in an owner-only temporary directory`)
  }
  let current = temporaryRoot
  for (const component of relativeParent.split('/').filter(Boolean)) {
    current = join(current, component)
    const info = lstatSync(current)
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (info.mode & 0o077) !== 0 ||
      !isOwnedByCurrentUser(info)
    ) {
      throw new Error(`${label} directory must be owner-only and must not contain symlinks`)
    }
  }
  const info = lstatSync(parent)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    !isOwnedByCurrentUser(info)
  ) {
    throw new Error(`${label} directory must be owner-only and must not contain symlinks`)
  }
  return parent
}

function isOwnedByCurrentUser(info) {
  return typeof process.getuid !== 'function' || info.uid === process.getuid()
}

function validateAvailableStorage(path) {
  const stats = statfsSync(dirname(path))
  const available = stats.bavail * stats.bsize
  if (!Number.isSafeInteger(available) || available < MAX_RESTORE_FILE_BYTES) {
    throw new Error('insufficient free space for the restore artifact limit')
  }
}

function validateOutputPath(value, extension) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('output path is invalid')
  const output = resolve(value)
  if (extname(output).toLowerCase() !== extension)
    throw new Error('output file extension is invalid')
  const name = output.slice(output.lastIndexOf('/') + 1)
  if (!OUTPUT_NAME_PATTERN.test(name)) throw new Error('output file name is invalid')

  validateOwnerOnlyTempParent(dirname(output), 'restore output')
  validateAvailableStorage(output)
  if (existsSync(output)) throw new Error('refusing to overwrite an existing restore file')
  return output
}

function privateTempDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  chmodSync(directory, 0o700)
  return directory
}

function stagedOutputPath(output) {
  const directory = privateTempDirectory('production-restore-output-')
  const path = join(directory, output.slice(output.lastIndexOf('/') + 1))
  writeFileSync(path, '', { mode: 0o600 })
  return { directory, path }
}

function commitStagedOutput(staged, output) {
  validateOwnerOnlyTempParent(dirname(output), 'restore output')
  if (existsSync(output)) throw new Error('refusing to overwrite an existing restore file')
  // Both paths live below the OS temporary root. A hard-link commit is
  // atomic and no-clobber: unlike rename, it cannot replace a symlink/file
  // created after the initial destination check.
  linkSync(staged, output)
  unlinkSync(staged)
}

function validateInputFile(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('input file is invalid')
  const file = resolve(value)
  if (extname(file).toLowerCase() !== '.sql') throw new Error('restore input must be a .sql file')
  validateOwnerOnlyTempParent(dirname(file), 'restore input')
  const info = lstatSync(file)
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    !isOwnedByCurrentUser(info) ||
    (info.mode & 0o077) !== 0 ||
    info.size > MAX_RESTORE_FILE_BYTES
  ) {
    throw new Error('restore input must be an owner-only regular file within the size limit')
  }
  return file
}

function validateManifestInputFile(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('manifest file is invalid')
  const file = resolve(value)
  if (extname(file).toLowerCase() !== '.json')
    throw new Error('restore manifest must be a .json file')
  validateOwnerOnlyTempParent(dirname(file), 'restore manifest')
  const info = lstatSync(file)
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    !isOwnedByCurrentUser(info) ||
    (info.mode & 0o077) !== 0 ||
    info.size > MAX_RESTORE_MANIFEST_BYTES
  ) {
    throw new Error('restore manifest must be an owner-only regular file within the size limit')
  }
  return file
}

function validateRestoreOutputSize(path) {
  const info = lstatSync(path)
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    !isOwnedByCurrentUser(info) ||
    (info.mode & 0o077) !== 0 ||
    info.size > MAX_RESTORE_FILE_BYTES
  ) {
    throw new Error('restore output exceeds the maximum allowed size')
  }
}

async function sha256File(path) {
  const info = lstatSync(path)
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    !isOwnedByCurrentUser(info) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error('restore artifact must remain an owner-only regular file')
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.byteLength
    if (bytes > MAX_RESTORE_FILE_BYTES) {
      throw new Error('restore artifact exceeds the maximum allowed size')
    }
    hash.update(chunk)
  }
  const after = lstatSync(path)
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    !isOwnedByCurrentUser(after) ||
    (after.mode & 0o077) !== 0 ||
    after.size !== info.size ||
    bytes !== info.size
  ) {
    throw new Error('restore artifact changed while it was being verified')
  }
  return hash.digest('hex')
}

export function productionRestoreCommand(operation, options) {
  if (!DESTRUCTIVE_OPERATIONS.has(operation) && operation !== 'time-travel-info') {
    throw new Error('unknown restore operation')
  }
  const database = asString(options?.database)
  // Once the reviewed name→UUID lookup has succeeded, use the UUID for every
  // subsequent D1 operation. Name resolution is mutable, so repeating a
  // destructive command with the name would leave a TOCTOU window.
  const databaseIdentifier = options?.databaseId
    ? validateRestoreDatabaseId(options.databaseId)
    : database
  if (operation !== 'download-backup' && operation !== 'upload-pre-restore' && !database) {
    throw new Error('database is required')
  }
  switch (operation) {
    case 'time-travel-info':
      return ['d1', 'time-travel', 'info', databaseIdentifier]
    case 'time-travel-restore':
      validateRestoreTimestamp(options?.timestamp, options?.nowMs)
      return [
        'd1',
        'time-travel',
        'restore',
        databaseIdentifier,
        `--timestamp=${options.timestamp}`,
      ]
    case 'export-before-restore':
      return [
        'd1',
        'export',
        databaseIdentifier,
        '--remote',
        '--skip-confirmation',
        `--output=${options.output}`,
      ]
    case 'download-backup':
      return [
        'r2',
        'object',
        'get',
        `${options.bucket}/${options.key}`,
        `--file=${options.output}`,
        '--remote',
      ]
    case 'upload-pre-restore':
      validatePreRestoreKey(options.key, options.service)
      return [
        'r2',
        'object',
        'put',
        `${options.bucket}/${options.key}`,
        `--file=${options.file}`,
        '--content-type=application/sql',
        '--remote',
      ]
    case 'create-restore-db':
      validateRestoreDatabaseName(database)
      return ['d1', 'create', database]
    case 'import-backup':
      return ['d1', 'execute', databaseIdentifier, '--remote', `--file=${options.file}`, '--yes']
    default:
      throw new Error('unknown restore operation')
  }
}

function restoreRuntime(dependencies = {}) {
  return {
    environment: dependencies.environment ?? process.env,
    nowMs: dependencies.nowMs ?? Date.now(),
    serviceConfig: dependencies.serviceConfig ?? serviceConfig,
    execFileSync: dependencies.execFileSync ?? execFileSync,
    runProductionWrangler: dependencies.runProductionWrangler ?? runProductionWrangler,
    logger: dependencies.logger ?? console,
  }
}

function runRestorePreflight(service, { checkRemoteSecrets = false } = {}, dependencies = {}) {
  const runtime = restoreRuntime(dependencies)
  // Establish checkout trust before any repository config or credential-bearing
  // environment value is inspected. Restore is a production state mutation and
  // is intentionally restricted to the protected production workflow.
  runtime.execFileSync(
    process.execPath,
    [join(root, 'scripts/require-production-provisioning.mjs')],
    {
      cwd: root,
      env: productionStaticEnvironment(runtime.environment),
      stdio: 'inherit',
    },
  )
  const ops = runtime.serviceConfig('ops')
  const admin = runtime.serviceConfig('admin')
  const reviewedDatabaseIds = { admin: admin.databaseId }
  for (const target of ops.backupTargets) {
    if (target === 'admin') continue
    reviewedDatabaseIds[target] = runtime.serviceConfig(target).databaseId
  }
  validateRestoreDatabaseBindings(ops.databaseIds, reviewedDatabaseIds)
  validateRestoreCloudflareAccount(ops.accountId, runtime.environment)
  validateRestoreSigningPublicKey(
    ops.signingPublicKey,
    runtime.environment.BACKUP_SIGNING_PUBLIC_KEY,
  )
  const childEnv = productionEnvironment(runtime.environment)
  runtime.execFileSync(
    process.execPath,
    [join(root, 'scripts/check-production-config.mjs'), service],
    {
      cwd: root,
      env: childEnv,
      stdio: 'inherit',
    },
  )
  runtime.execFileSync(process.execPath, [join(root, 'scripts/check-r2-private.mjs')], {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
  })
  if (checkRemoteSecrets) {
    runtime.execFileSync(
      process.execPath,
      [join(root, 'scripts/check-production-secrets.mjs'), service],
      {
        cwd: root,
        env: childEnv,
        stdio: 'inherit',
      },
    )
  }
  return childEnv
}

function runWrangler(service, args, childEnv, dependencies = {}) {
  const runtime = restoreRuntime(dependencies)
  runtime.runProductionWrangler(
    args,
    {
      cwd: join(root, 'services', service),
      env: childEnv,
      stdio: 'inherit',
      timeout: RESTORE_CHILD_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    },
    runtime.environment,
  )
}

function runWranglerJson(service, args, childEnv, dependencies = {}) {
  const runtime = restoreRuntime(dependencies)
  return runtime.runProductionWrangler(
    args,
    {
      cwd: join(root, 'services', service),
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: RESTORE_CHILD_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    },
    runtime.environment,
  )
}

export function verifyRestoreDatabase(
  service,
  database,
  expectedId,
  childEnv,
  runCommand = runWranglerJson,
) {
  const output = runCommand(service, ['d1', 'info', database, '--json'], childEnv)
  validateRestoreDatabaseInfo(output, expectedId)
}

/**
 * Export the current database state into a private, retained artifact before
 * an in-place Time Travel restore. The caller owns cleanup after validating
 * the restored system; deleting it in this helper would remove the only
 * rollback evidence if the destructive command fails.
 */
export async function createPreRestoreArtifact(
  service,
  database,
  childEnv,
  runCommand = runWrangler,
  databaseId,
) {
  const directory = privateTempDirectory('production-restore-before-time-travel-')
  const path = join(directory, 'pre-restore.sql')
  validateAvailableStorage(path)
  writeFileSync(path, '', { mode: 0o600 })
  try {
    await runCommand(
      service,
      productionRestoreCommand('export-before-restore', {
        database,
        databaseId,
        output: path,
      }),
      childEnv,
    )
    validateRestoreOutputSize(path)
    const sha256 = await sha256File(path)
    return { directory, path, sha256 }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function downloadLatestManifest(
  ops,
  childEnv,
  target,
  targetConfig,
  signingPublicKey,
  runCommand = runWrangler,
) {
  const directory = privateTempDirectory('production-restore-manifest-')
  const output = join(directory, 'latest.json')
  writeFileSync(output, '', { mode: 0o600 })
  try {
    runCommand(
      'ops',
      productionRestoreCommand('download-backup', {
        bucket: ops.bucket,
        key: 'latest.json',
        output,
      }),
      childEnv,
    )
    validateRestoreOutputSize(output)
    if (lstatSync(output).size > MAX_RESTORE_MANIFEST_BYTES) {
      throw new Error('restore manifest is too large')
    }
    const manifest = JSON.parse(readFileSync(output, 'utf8'))
    return validateRestoreProvenance(manifest, target, ops.accountId, targetConfig.databaseId, {
      signingPublicKey,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function retainPreRestoreArtifact(
  artifact,
  ops,
  service,
  childEnv,
  runCommand = runWrangler,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const key = `pre-restore/${service}/${timestamp}-${crypto.randomUUID()}.sql`
  validatePreRestoreKey(key, service)
  await runCommand(
    'ops',
    productionRestoreCommand('upload-pre-restore', {
      bucket: ops.bucket,
      file: artifact.path,
      key,
      service,
    }),
    childEnv,
  )

  // Read the just-uploaded object back through the same fixed R2 command and
  // verify its bytes before allowing the destructive Time Travel operation.
  const directory = privateTempDirectory('production-restore-before-verify-')
  const output = join(directory, 'pre-restore.sql')
  writeFileSync(output, '', { mode: 0o600 })
  try {
    await runCommand(
      'ops',
      productionRestoreCommand('download-backup', {
        bucket: ops.bucket,
        key,
        output,
      }),
      childEnv,
    )
    validateRestoreOutputSize(output)
    const sha256 = await sha256File(output)
    if (sha256 !== artifact.sha256) throw new Error('remote pre-restore artifact digest mismatch')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  return key
}

export function parseRestoreOptions(rawArgs) {
  const allowed = new Set([
    '--confirm',
    '--database',
    '--database-id',
    '--file',
    '--key',
    '--manifest',
    '--output',
    '--service',
    '--sha256',
    '--target',
    '--timestamp',
  ])
  const options = {}
  for (let index = 0; index < rawArgs.length; index += 1) {
    const option = rawArgs[index]
    if (!allowed.has(option) || options[option] !== undefined || rawArgs[index + 1] === undefined) {
      throw new Error('invalid restore options')
    }
    options[option] = rawArgs[index + 1]
    index += 1
  }
  return options
}

const RESTORE_OPTIONS_BY_OPERATION = {
  'time-travel-info': new Set(['--service']),
  'time-travel-restore': new Set(['--confirm', '--service', '--timestamp']),
  'export-before-restore': new Set(['--confirm', '--output', '--service']),
  'download-backup': new Set(['--confirm', '--key', '--output', '--target', '--sha256']),
  'create-restore-db': new Set(['--confirm', '--database', '--service']),
  'import-backup': new Set([
    '--confirm',
    '--database',
    '--database-id',
    '--file',
    '--key',
    '--manifest',
    '--service',
    '--sha256',
    '--target',
  ]),
}

export function validateRestoreOperationOptions(operation, options) {
  const allowed = RESTORE_OPTIONS_BY_OPERATION[operation]
  if (!allowed || Object.keys(options).some((name) => !allowed.has(name))) {
    throw new Error('invalid restore options for operation')
  }
  return true
}

function requireOption(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

export async function runRestoreCli(argv, dependencies = {}) {
  const runtime = restoreRuntime(dependencies)
  const getServiceConfig = runtime.serviceConfig
  const wrangler = (service, args, childEnv) => runWrangler(service, args, childEnv, runtime)
  const wranglerJson = (service, args, childEnv) =>
    runWranglerJson(service, args, childEnv, runtime)
  const [operation, ...rawArgs] = argv
  const options = parseRestoreOptions(rawArgs)
  validateRestoreOperationOptions(operation, options)
  const service = options['--service'] ?? 'admin'
  if (!SERVICE_PATTERN.test(service)) throw new Error('invalid service name')

  if (DESTRUCTIVE_OPERATIONS.has(operation)) {
    validateRestoreConfirmation(requireOption(options, '--confirm'))
  }

  // This is the sole CLI preflight. It proves checkout trust before reading
  // repository config, validates the reviewed account/key bindings, and runs
  // the shared production config and private-R2 checks for every operation.
  const childEnv = runRestorePreflight(
    operation === 'download-backup' ? 'ops' : service,
    {},
    runtime,
  )

  if (operation === 'download-backup') {
    const target = options['--target'] ?? 'admin'
    const key = requireOption(options, '--key')
    validateBackupKey(key, target)
    if (key === 'latest.json' && options['--sha256']) {
      throw new Error('latest.json is a manifest and must not use a SQL digest')
    }
    const expectedSha =
      key === 'latest.json' ? undefined : validateRestoreSha256(options['--sha256'])
    const ops = getServiceConfig('ops')
    if (!ops.bucket) throw new Error('configured backup bucket is missing')
    validateRestoreTarget(target, ops.backupTargets)
    const targetConfig = getServiceConfig(target)
    if (!targetConfig.databaseName || !targetConfig.databaseId) {
      throw new Error('configured backup target database is missing')
    }
    const signingPublicKey = asString(runtime.environment.BACKUP_SIGNING_PUBLIC_KEY)
    const output = validateOutputPath(
      requireOption(options, '--output'),
      key === 'latest.json' ? '.json' : '.sql',
    )
    const staged = stagedOutputPath(output)
    try {
      const manifestEntry =
        key === 'latest.json'
          ? undefined
          : downloadLatestManifest(ops, childEnv, target, targetConfig, signingPublicKey, wrangler)
      if (manifestEntry && expectedSha && manifestEntry.sha256 !== expectedSha) {
        throw new Error('requested backup SHA-256 does not match the reviewed manifest')
      }
      wrangler(
        'ops',
        productionRestoreCommand('download-backup', {
          bucket: ops.bucket,
          key,
          output: staged.path,
        }),
        childEnv,
      )
      validateRestoreOutputSize(staged.path)
      if (key === 'latest.json') {
        if (lstatSync(staged.path).size > MAX_RESTORE_MANIFEST_BYTES) {
          throw new Error('restore manifest is too large')
        }
        validateRestoreProvenance(
          JSON.parse(readFileSync(staged.path, 'utf8')),
          target,
          ops.accountId,
          targetConfig.databaseId,
          { signingPublicKey },
        )
      } else if (expectedSha && (await sha256File(staged.path)) !== expectedSha) {
        throw new Error('downloaded backup SHA-256 does not match the manifest')
      }
      commitStagedOutput(staged.path, output)
    } finally {
      rmSync(staged.directory, { recursive: true, force: true })
    }
    runtime.logger.log(`restore artifact written to ${output}`)
    return
  }

  const config = getServiceConfig(service)
  if (!config.databaseName) throw new Error('configured D1 database name is missing')
  if (operation === 'time-travel-info') {
    verifyRestoreDatabase(service, config.databaseName, config.databaseId, childEnv, wranglerJson)
    wrangler(
      service,
      productionRestoreCommand(operation, {
        database: config.databaseName,
        databaseId: config.databaseId,
      }),
      childEnv,
    )
  } else if (operation === 'time-travel-restore') {
    const timestamp = requireOption(options, '--timestamp')
    validateRestoreTimestamp(timestamp, runtime.nowMs)
    verifyRestoreDatabase(service, config.databaseName, config.databaseId, childEnv, wranglerJson)
    // Always create a current-state escape hatch immediately before the
    // destructive in-place Time Travel restore. This cannot be skipped by
    // calling the wrapper directly with a different operation order.
    const preRestore = await createPreRestoreArtifact(
      service,
      config.databaseName,
      childEnv,
      wrangler,
      config.databaseId,
    )
    const ops = getServiceConfig('ops')
    if (!ops.bucket) throw new Error('configured backup bucket is missing')
    const remotePreRestoreKey = await retainPreRestoreArtifact(
      preRestore,
      ops,
      service,
      childEnv,
      wrangler,
    )
    runtime.logger.error(
      `pre-restore artifact retained locally at ${preRestore.path} and in R2 as ${remotePreRestoreKey} (SHA-256 ${preRestore.sha256}); remove it only after restore validation`,
    )
    // Re-check the reviewed name immediately before the destructive call;
    // the actual command uses the UUID so a name reassignment cannot
    // redirect the restore between the initial preflight and this point.
    verifyRestoreDatabase(service, config.databaseName, config.databaseId, childEnv, wranglerJson)
    wrangler(
      service,
      productionRestoreCommand(operation, {
        database: config.databaseName,
        databaseId: config.databaseId,
        timestamp,
        nowMs: runtime.nowMs,
      }),
      childEnv,
    )
  } else if (operation === 'export-before-restore') {
    verifyRestoreDatabase(service, config.databaseName, config.databaseId, childEnv, wranglerJson)
    const output = validateOutputPath(requireOption(options, '--output'), '.sql')
    const staged = stagedOutputPath(output)
    try {
      wrangler(
        service,
        productionRestoreCommand(operation, {
          database: config.databaseName,
          databaseId: config.databaseId,
          output: staged.path,
        }),
        childEnv,
      )
      validateRestoreOutputSize(staged.path)
      commitStagedOutput(staged.path, output)
    } finally {
      rmSync(staged.directory, { recursive: true, force: true })
    }
    runtime.logger.log(`restore artifact written to ${output}`)
  } else if (operation === 'create-restore-db') {
    const database = requireOption(options, '--database')
    validateRestoreDatabaseName(database, config.databaseName)
    wrangler(service, productionRestoreCommand(operation, { database }), childEnv)
  } else if (operation === 'import-backup') {
    const database = requireOption(options, '--database')
    validateRestoreDatabaseName(database, config.databaseName)
    const databaseId = validateRestoreDatabaseId(requireOption(options, '--database-id'))
    const file = validateInputFile(requireOption(options, '--file'))
    const expectedSha = validateRestoreSha256(requireOption(options, '--sha256'))
    const ops = getServiceConfig('ops')
    const target = options['--target'] ?? service
    validateRestoreTarget(target, ops.backupTargets)
    if (target !== service) throw new Error('restore target must match the selected service')
    const targetConfig = getServiceConfig(target)
    if (!targetConfig.databaseId) throw new Error('configured restore target database is missing')
    verifyRestoreDatabase(service, database, databaseId, childEnv, wranglerJson)
    const manifestFile = validateManifestInputFile(requireOption(options, '--manifest'))
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const requestedKey = requireOption(options, '--key')
    // Fetch latest.json from R2 immediately before the import. The local
    // manifest is checked only as human-provided evidence and cannot pick
    // a backup generation that the private R2 manifest does not select.
    const signingPublicKey = asString(runtime.environment.BACKUP_SIGNING_PUBLIC_KEY)
    const remoteProvenance = downloadLatestManifest(
      ops,
      childEnv,
      target,
      targetConfig,
      signingPublicKey,
      wrangler,
    )
    const provenance = validateLocalManifestAgainstRemote(
      manifest,
      target,
      ops.accountId,
      targetConfig.databaseId,
      remoteProvenance,
      { key: requestedKey, sha256: expectedSha, signingPublicKey },
    )
    if (provenance.sha256 !== expectedSha) {
      throw new Error('restore input SHA-256 does not match the reviewed manifest')
    }
    const staged = privateTempDirectory('production-restore-input-')
    const stagedFile = join(staged, 'restore.sql')
    try {
      copyFileSync(file, stagedFile)
      chmodSync(stagedFile, 0o600)
      if ((await sha256File(stagedFile)) !== expectedSha) {
        throw new Error('restore input SHA-256 does not match the manifest')
      }
      // The destination was verified before the remote manifest and local
      // file checks. Verify again immediately before the destructive SQL
      // execution, and pass the UUID rather than resolving the name again.
      verifyRestoreDatabase(service, database, databaseId, childEnv, wranglerJson)
      wrangler(
        service,
        productionRestoreCommand(operation, { database, databaseId, file: stagedFile }),
        childEnv,
      )
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
  } else {
    throw new Error('unknown restore operation')
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  try {
    await runRestoreCli(process.argv.slice(2))
  } catch {
    console.error(
      'production restore blocked: validate the reviewed checkout, config, secrets, and restore inputs',
    )
    process.exitCode = 1
  }
}
