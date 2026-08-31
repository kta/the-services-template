#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadNativeBoundaryManifest } from './native-boundary-manifest.mjs'
import { loadServiceCatalog } from './service-catalog.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_ENVIRONMENT = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'NO_COLOR',
  'CI',
  'PATH',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'DEVELOPER_DIR',
  'SDKROOT',
  'MACOSX_DEPLOYMENT_TARGET',
])

function normalizedService(service) {
  return (
    service?.native === true &&
    typeof service.directory === 'string' &&
    /^[a-z][a-z0-9_]{0,62}$/.test(service.directory) &&
    service.package === `@app/${service.directory}`
  )
}

function canonicalHttpsOrigin(value) {
  if (typeof value !== 'string' || value.endsWith('/')) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === value
    )
  } catch {
    return false
  }
}

export function nativeReleaseCheckInvocation(workspaceRoot, service, manifest, environment = {}) {
  if (!normalizedService(service)) {
    throw new Error('release check requires a normalized catalog native service')
  }
  if (!canonicalHttpsOrigin(manifest?.releaseOrigin)) {
    throw new Error('release check requires one reviewed canonical HTTPS origin')
  }
  const root = resolve(workspaceRoot)
  const originVariable = `TAURI_${service.directory.toUpperCase()}_API_ORIGIN`
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => RELEASE_ENVIRONMENT.has(name) && typeof value === 'string',
    ),
  )
  childEnvironment[originVariable] = manifest.releaseOrigin
  return {
    command: 'cargo',
    args: [
      'check',
      '--locked',
      '--release',
      '--manifest-path',
      join(root, `services/${service.directory}/src-tauri/Cargo.toml`),
    ],
    cwd: root,
    environment: childEnvironment,
  }
}

function executeNativeReleaseCheck(invocation, executor = execFileSync) {
  executor(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdio: 'inherit',
    timeout: 30 * 60 * 1_000,
    killSignal: 'SIGTERM',
  })
}

async function main() {
  const [directory, ...extra] = process.argv.slice(2)
  if (!directory || extra.length > 0) {
    throw new Error('usage: check-native-release.mjs <catalog-native-service>')
  }
  const services = await loadServiceCatalog(DEFAULT_ROOT)
  const service = services.find((candidate) => candidate.directory === directory)
  if (!service?.native) throw new Error(`${directory}: service is not a catalog native service`)
  const manifest = await loadNativeBoundaryManifest(DEFAULT_ROOT, service)
  executeNativeReleaseCheck(
    nativeReleaseCheckInvocation(DEFAULT_ROOT, service, manifest, process.env),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `native release check blocked: ${error instanceof Error ? error.message : 'failure'}`,
    )
    process.exitCode = error?.status ?? 1
  })
}
