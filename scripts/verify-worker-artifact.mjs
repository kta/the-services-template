#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forbiddenWorkerArtifactMarkersInText } from './secret-boundary.mjs'
import {
  loadServiceRepositoryCatalog,
  requireCatalogDeployableService,
} from './service-catalog.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const WORKER_ARTIFACT_MANIFEST = 'production-worker-manifest.json'
const MANIFEST_VERSION = 2
const SERVICE_PATTERN = /^[a-z][a-z0-9_]*$/

function normalizeServices(services) {
  const values = Array.isArray(services) ? services : [services]
  const normalized = [...new Set(values)].filter((service) => typeof service === 'string').sort()
  if (
    normalized.length === 0 ||
    normalized.some((service) => !SERVICE_PATTERN.test(service) || service === 'example_service')
  ) {
    throw new Error('Worker artifact service names are invalid')
  }
  return normalized
}

export function requireCatalogWorkerArtifactServices(catalog, services) {
  const normalized = Array.isArray(services) ? services : [services]
  if (normalized.length === 0) throw new Error('Worker artifact service names are invalid')
  for (const service of normalized) requireCatalogDeployableService(catalog, service)
  return normalized
}

function serviceDist(rootDirectory, service) {
  return join(resolve(rootDirectory), 'services', service, 'dist')
}

function relativeArtifactPath(rootDirectory, path) {
  const value = relative(resolve(rootDirectory), path).split('/').join('/')
  if (!value || value.startsWith('../') || value.includes('/../') || isAbsolute(value)) {
    throw new Error('Worker artifact path escapes the workspace')
  }
  return value
}

function requiredWorkerPaths(service) {
  const prefix = `services/${service}/dist`
  if (service !== 'notifier' && service !== 'ops') {
    return [`${prefix}/${service}/index.js`, `${prefix}/client`]
  }
  return [`${prefix}/index.js`]
}

function assertDirectory(path, description) {
  if (!existsSync(path)) throw new Error(`${description} is missing`)
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error(`${description} symbolic links are not allowed`)
  if (!info.isDirectory()) throw new Error(`${description} must be a directory`)
}

function assertNoSymlinkAncestors(workspace, path) {
  const rootDirectory = resolve(workspace)
  const target = resolve(path)
  const relation = relative(rootDirectory, target)
  if (isAbsolute(relation) || relation.startsWith(`..${sep}`) || relation === '..') {
    throw new Error('Worker artifact path escapes the workspace')
  }
  let current = rootDirectory
  for (const part of relation.split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = lstatSync(current, { throwIfNoEntry: false })
    if (info?.isSymbolicLink()) {
      throw new Error('Worker artifact path cannot traverse a symbolic link')
    }
    if (current !== target && info && !info.isDirectory()) {
      throw new Error('Worker artifact path has a non-directory ancestor')
    }
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function artifactProvenance(environment = process.env) {
  const values = {
    repository: environment.GITHUB_REPOSITORY,
    sha: environment.GITHUB_SHA,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
    runId: environment.GITHUB_RUN_ID,
  }
  if (Object.values(values).every((value) => value === undefined || value === '')) return undefined
  if (
    !/^[^/\s]+\/[^/\s]+$/.test(values.repository ?? '') ||
    !/^[0-9a-f]{40}$/i.test(values.sha ?? '') ||
    typeof values.workflowRef !== 'string' ||
    values.workflowRef.length === 0 ||
    values.workflowRef.length > 512 ||
    !/^\d{1,32}$/.test(values.runId ?? '')
  ) {
    throw new Error('Worker artifact provenance is incomplete or invalid')
  }
  return values
}

function collectFiles(rootDirectory, directory, files) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${relativeArtifactPath(rootDirectory, path)}: symbolic links are not allowed`,
      )
    }
    if (entry.isDirectory()) {
      collectFiles(rootDirectory, path, files)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(
        `${relativeArtifactPath(rootDirectory, path)}: non-regular files are not allowed`,
      )
    }
    const content = readFileSync(path)
    const relativePath = relativeArtifactPath(rootDirectory, path)
    const forbiddenMarkers = forbiddenWorkerArtifactMarkersInText(content.toString('latin1'))
    if (forbiddenMarkers.length > 0) {
      throw new Error(
        `${relativePath}: secret marker ${forbiddenMarkers[0]} is not allowed in Worker artifacts`,
      )
    }
    files.push({ path: relativePath, size: content.byteLength, sha256: sha256(content) })
  }
}

export function buildWorkerArtifactManifest(rootDirectory = root, services) {
  const workspace = resolve(rootDirectory)
  const normalizedServices = normalizeServices(services)
  const files = []
  for (const service of normalizedServices) {
    const dist = serviceDist(workspace, service)
    // lstat the complete path before any recursive read. A symlinked
    // `services/<name>` or `dist` parent must not redirect the scanner outside
    // the reviewed checkout.
    assertNoSymlinkAncestors(workspace, dist)
    assertDirectory(dist, `${service}/dist`)
    collectFiles(workspace, dist, files)
    for (const required of requiredWorkerPaths(service)) {
      if (required.endsWith('/client')) {
        assertDirectory(join(workspace, required), `${service}/dist/client`)
        continue
      }
      const info = lstatSync(join(workspace, required), { throwIfNoEntry: false })
      if (!info?.isFile()) throw new Error(`${required}: required Worker entry is missing`)
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  const provenance = artifactProvenance()
  return {
    version: MANIFEST_VERSION,
    services: normalizedServices,
    ...(provenance ? { provenance } : {}),
    files,
  }
}

function parseManifest(source) {
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch {
    throw new Error('Worker artifact manifest is invalid JSON')
  }
  if (
    !manifest ||
    manifest.version !== MANIFEST_VERSION ||
    !Array.isArray(manifest.services) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('Worker artifact manifest has an invalid shape')
  }
  if (manifest.provenance !== undefined) {
    const provenance = manifest.provenance
    if (
      !provenance ||
      typeof provenance !== 'object' ||
      Array.isArray(provenance) ||
      !/^[^/\s]+\/[^/\s]+$/.test(provenance.repository ?? '') ||
      !/^[0-9a-f]{40}$/i.test(provenance.sha ?? '') ||
      typeof provenance.workflowRef !== 'string' ||
      provenance.workflowRef.length === 0 ||
      provenance.workflowRef.length > 512 ||
      !/^\d{1,32}$/.test(provenance.runId ?? '')
    ) {
      throw new Error('Worker artifact manifest has invalid provenance')
    }
  }
  return manifest
}

export function verifyWorkerArtifact(
  rootDirectory = root,
  services,
  manifestPath = WORKER_ARTIFACT_MANIFEST,
) {
  const workspace = resolve(rootDirectory)
  const normalizedServices = normalizeServices(services)
  const manifestFile = resolve(workspace, manifestPath)
  const manifestRelative = relative(workspace, manifestFile)
  if (isAbsolute(manifestRelative) || manifestRelative.startsWith('..')) {
    throw new Error('Worker artifact manifest path escapes the workspace')
  }
  assertNoSymlinkAncestors(workspace, manifestFile)
  const manifestInfo = lstatSync(manifestFile, { throwIfNoEntry: false })
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error('Worker artifact manifest is missing or not a regular file')
  }
  const expected = parseManifest(readFileSync(manifestFile, 'utf8'))
  const actual = buildWorkerArtifactManifest(workspace, normalizedServices)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Worker artifact does not match the reviewed manifest')
  }
  return actual
}

export function writeWorkerArtifactManifest(
  rootDirectory = root,
  services,
  manifestPath = WORKER_ARTIFACT_MANIFEST,
) {
  const workspace = resolve(rootDirectory)
  const path = resolve(workspace, manifestPath)
  if (!path.startsWith(`${workspace}/`) && path !== workspace) {
    throw new Error('Worker artifact manifest path escapes the workspace')
  }
  assertNoSymlinkAncestors(workspace, path)
  mkdirSync(dirname(path), { recursive: true })
  assertNoSymlinkAncestors(workspace, path)
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('Worker artifact manifest must be a regular file')
  }
  const manifest = buildWorkerArtifactManifest(workspace, services)
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
  return manifest
}

function archivePathName(raw) {
  const value = String(raw).trim()
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`unsafe archive path: ${value || '(empty)'}`)
  }
  const withoutSlash = value.endsWith('/') ? value.slice(0, -1) : value
  const parts = withoutSlash.split('/')
  if (parts.includes('..') || parts.includes('.') || withoutSlash !== parts.join('/')) {
    throw new Error(`unsafe archive path: ${value}`)
  }
  return withoutSlash
}

function allowedArchivePath(path, services) {
  if (path === WORKER_ARTIFACT_MANIFEST) return true
  const normalized = normalizeServices(services)
  return normalized.some((service) => {
    const prefix = `services/${service}/dist`
    return path === prefix || path.startsWith(`${prefix}/`)
  })
}

export function validateArchiveEntries(entries, verboseEntries, services) {
  const normalizedServices = normalizeServices(services)
  const names = entries.map(archivePathName)
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) throw new Error(`duplicate archive entry: ${name}`)
    seen.add(name)
    if (!allowedArchivePath(name, normalizedServices)) {
      throw new Error(`archive entry is outside reviewed Worker outputs: ${name}`)
    }
  }
  if (!seen.has(WORKER_ARTIFACT_MANIFEST)) {
    throw new Error('Worker artifact archive has no manifest')
  }
  if (!Array.isArray(verboseEntries) || verboseEntries.length !== names.length) {
    throw new Error('Worker artifact archive listing is incomplete')
  }
  for (const line of verboseEntries) {
    const type = String(line)[0]
    if (type !== 'd' && type !== '-') {
      throw new Error('non-regular archive entry is not allowed')
    }
  }
  return true
}

function archiveEntries(archivePath) {
  const info = lstatSync(archivePath, { throwIfNoEntry: false })
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error('Worker artifact archive must be a regular file')
  }
  try {
    const list = execFileSync('tar', ['--list', '--gzip', `--file=${archivePath}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const verbose = execFileSync(
      'tar',
      ['--list', '--verbose', '--gzip', `--file=${archivePath}`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return {
      entries: list.split('\n').filter(Boolean),
      verboseEntries: verbose.split('\n').filter(Boolean),
    }
  } catch {
    throw new Error('Worker artifact archive cannot be listed safely')
  }
}

function verifyWorkerArtifactArchive(archivePath, services) {
  const listing = archiveEntries(resolve(archivePath))
  validateArchiveEntries(listing.entries, listing.verboseEntries, services)
  return true
}

export function installVerifiedWorkerArtifact({ archivePath, workspaceRoot = root, services }) {
  const workspace = resolve(workspaceRoot)
  const normalizedServices = normalizeServices(services)
  verifyWorkerArtifactArchive(archivePath, normalizedServices)
  const staging = mkdtempSync(join(tmpdir(), 'verified-worker-artifact-'))
  try {
    execFileSync(
      'tar',
      [
        '--extract',
        '--gzip',
        `--file=${resolve(archivePath)}`,
        `--directory=${staging}`,
        '--no-same-owner',
        '--no-same-permissions',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    verifyWorkerArtifact(staging, normalizedServices)
    assertDirectory(workspace, 'Worker artifact install workspace')
    const servicesDirectory = join(workspace, 'services')
    assertNoSymlinkAncestors(workspace, servicesDirectory)
    mkdirSync(servicesDirectory, { recursive: true })
    assertDirectory(servicesDirectory, 'services')
    for (const service of normalizedServices) {
      const source = serviceDist(staging, service)
      const destination = serviceDist(workspace, service)
      assertDirectory(source, `${service}/dist`)
      const serviceDirectory = join(servicesDirectory, service)
      assertNoSymlinkAncestors(workspace, serviceDirectory)
      mkdirSync(serviceDirectory, { recursive: true })
      assertDirectory(serviceDirectory, `${service} service directory`)
      assertNoSymlinkAncestors(workspace, destination)
      const existingDestination = lstatSync(destination, { throwIfNoEntry: false })
      if (
        existingDestination &&
        (!existingDestination.isDirectory() || existingDestination.isSymbolicLink())
      ) {
        throw new Error(`${service}/dist must be a regular directory`)
      }
      rmSync(destination, { recursive: true, force: true })
      cpSync(source, destination, { recursive: true, force: false, errorOnExist: true })
    }
    const manifestSource = join(staging, WORKER_ARTIFACT_MANIFEST)
    const manifestDestination = join(workspace, WORKER_ARTIFACT_MANIFEST)
    assertNoSymlinkAncestors(workspace, manifestDestination)
    const existingManifest = lstatSync(manifestDestination, { throwIfNoEntry: false })
    if (existingManifest && (!existingManifest.isFile() || existingManifest.isSymbolicLink())) {
      throw new Error('Worker artifact manifest must be a regular file')
    }
    cpSync(manifestSource, join(workspace, WORKER_ARTIFACT_MANIFEST), {
      force: true,
    })
    verifyWorkerArtifact(workspace, normalizedServices)
  } catch (error) {
    if (error instanceof Error && /Worker artifact/.test(error.message)) throw error
    throw new Error('Worker artifact could not be installed safely')
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return true
}

function parseCliArguments(args) {
  const options = { services: [] }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--service') {
      if (!args[index + 1]) throw new Error('--service requires a value')
      options.services.push(args[index + 1])
      index += 1
    } else if (['--archive', '--install-root', '--manifest'].includes(option)) {
      if (options[option.slice(2)] !== undefined || !args[index + 1]) {
        throw new Error(`${option} requires one value and may not be repeated`)
      }
      options[option.slice(2)] = args[index + 1]
      index += 1
    } else {
      throw new Error(`unknown Worker artifact option: ${option}`)
    }
  }
  if ((options.archive === undefined) !== (options['install-root'] === undefined)) {
    throw new Error('--archive and --install-root must be provided together')
  }
  if (options.archive !== undefined && options.manifest !== undefined) {
    throw new Error('--manifest is only supported when writing a manifest')
  }
  return options
}

const currentFile = fileURLToPath(import.meta.url)
async function main() {
  try {
    const options = parseCliArguments(process.argv.slice(2))
    const catalog = await loadServiceRepositoryCatalog(root)
    requireCatalogWorkerArtifactServices(catalog, options.services)
    if (options.archive !== undefined) {
      installVerifiedWorkerArtifact({
        archivePath: options.archive,
        workspaceRoot: options['install-root'],
        services: options.services,
      })
    } else {
      writeWorkerArtifactManifest(root, options.services, options.manifest)
    }
    console.log('Worker artifact manifest: ok')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Worker artifact check failed')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === currentFile) await main()
