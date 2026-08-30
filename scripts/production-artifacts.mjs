#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { appendFileSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadServiceRepositoryCatalog } from './service-catalog.mjs'
import {
  installVerifiedWorkerArtifact,
  WORKER_ARTIFACT_MANIFEST,
  writeWorkerArtifactManifest,
} from './verify-worker-artifact.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHANNEL_ARCHIVES = {
  ci: 'production-worker-bundles.tar.gz',
  bootstrap: 'production-bootstrap-worker-bundles.tar.gz',
}
const ACTIONS = new Set(['package', 'record-digest', 'verify-digest', 'install'])

function exactList(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

function expectedServices(catalog, channel, directories) {
  const deployable = [...(catalog.services ?? []), ...(catalog.workerOnlyServices ?? [])]
    .filter((service) => service.deployable)
    .map((service) => service.directory)
  if (channel === 'ci') return deployable

  const domain = directories[3]
  const deployableDomains = (catalog.services ?? [])
    .filter((service) => service.deployable && service.directory !== 'admin')
    .map((service) => service.directory)
  if (!deployableDomains.includes(domain)) return []
  return ['admin', 'notifier', 'ops', domain]
}

export function productionArtifactPlan(workspaceRoot, catalog, channel, action, directories = []) {
  const root = resolve(workspaceRoot)
  if (!Object.hasOwn(CHANNEL_ARCHIVES, channel) || !ACTIONS.has(action)) {
    throw new Error('unknown production artifact workflow operation')
  }
  if (['package', 'install'].includes(action)) {
    const expected = expectedServices(catalog, channel, directories)
    if (!exactList(directories, expected) || new Set(directories).size !== directories.length) {
      throw new Error('artifact services must exactly match catalog deployable services')
    }
  } else if (directories.length > 0) {
    throw new Error(`${action} does not accept service arguments`)
  }
  return {
    archivePath: join(root, CHANNEL_ARCHIVES[channel]),
    manifestPath: join(root, WORKER_ARTIFACT_MANIFEST),
    serviceDirectories: [...directories],
    distPaths: directories.map((directory) => `services/${directory}/dist`),
  }
}

function regularFile(path, label) {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`)
  }
}

function digest(path) {
  regularFile(path, 'production Worker archive')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runPlan(plan, action) {
  if (action === 'package') {
    const existing = lstatSync(plan.archivePath, { throwIfNoEntry: false })
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error('production Worker archive output must be a regular file')
    }
    rmSync(plan.archivePath, { force: true })
    writeWorkerArtifactManifest(DEFAULT_ROOT, plan.serviceDirectories)
    execFileSync(
      'tar',
      [
        '--create',
        '--gzip',
        `--file=${plan.archivePath}`,
        '--directory',
        DEFAULT_ROOT,
        WORKER_ARTIFACT_MANIFEST,
        ...plan.distPaths,
      ],
      { cwd: DEFAULT_ROOT, stdio: 'inherit', timeout: 5 * 60 * 1_000, killSignal: 'SIGTERM' },
    )
    regularFile(plan.archivePath, 'production Worker archive')
    return
  }
  if (action === 'record-digest') {
    const output = process.env.GITHUB_OUTPUT
    if (typeof output !== 'string' || output.length === 0) {
      throw new Error('GITHUB_OUTPUT is required to record the archive digest')
    }
    appendFileSync(output, `bundle_sha256=${digest(plan.archivePath)}\n`)
    return
  }
  if (action === 'verify-digest') {
    const expected = String(process.env.EXPECTED_BUNDLE_SHA256 ?? '').trim()
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('expected archive digest is invalid')
    const actual = digest(plan.archivePath)
    if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
      throw new Error('production Worker archive digest does not match')
    }
    return
  }
  installVerifiedWorkerArtifact({
    archivePath: plan.archivePath,
    workspaceRoot: DEFAULT_ROOT,
    services: plan.serviceDirectories,
  })
}

async function main() {
  const [channel, action, ...directories] = process.argv.slice(2)
  const catalog = await loadServiceRepositoryCatalog(DEFAULT_ROOT)
  const plan = productionArtifactPlan(DEFAULT_ROOT, catalog, channel, action, directories)
  runPlan(plan, action)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `production artifact workflow blocked: ${error instanceof Error ? error.message : 'failure'}`,
    )
    process.exitCode = error?.status ?? 1
  })
}
