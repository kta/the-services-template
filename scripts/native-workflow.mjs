#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadServiceCatalog } from './service-catalog.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function tauriArgs(service, ...args) {
  return {
    command: 'pnpm',
    args: ['--filter', service.package, 'exec', 'tauri', ...args],
  }
}

function nodeScript(root, script, ...args) {
  return {
    command: process.execPath,
    args: [join(root, 'scripts', script), ...args],
  }
}

export function nativeWorkflowInvocation(workspaceRoot, service, action) {
  const root = resolve(workspaceRoot)
  if (
    service?.native !== true ||
    typeof service.directory !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(service.directory) ||
    service.package !== `@app/${service.directory}`
  ) {
    throw new Error('native workflow requires a normalized catalog identity')
  }

  const serviceRoot = join(root, 'services', service.directory)
  const artifact = (...parts) => join(serviceRoot, 'src-tauri', ...parts)
  let invocation
  switch (action) {
    case 'boundary':
      invocation = nodeScript(root, 'check-tauri-boundary.mjs')
      break
    case 'build-macos':
      invocation = tauriArgs(
        service,
        'build',
        '--debug',
        '--bundles',
        'app',
        '--target',
        'universal-apple-darwin',
        '--no-sign',
      )
      break
    case 'verify-macos':
      invocation = nodeScript(
        root,
        'check-tauri-artifact.mjs',
        artifact('target', 'universal-apple-darwin', 'debug', 'bundle', 'macos'),
      )
      break
    case 'init-ios':
      invocation = tauriArgs(service, 'ios', 'init', '--ci', '--skip-targets-install')
      break
    case 'build-ios':
      invocation = tauriArgs(
        service,
        'ios',
        'build',
        '--debug',
        '--target',
        'aarch64-sim',
        '--no-sign',
      )
      break
    case 'verify-ios':
      invocation = nodeScript(root, 'check-tauri-artifact.mjs', artifact('gen', 'apple', 'build'))
      break
    case 'init-android':
      invocation = tauriArgs(service, 'android', 'init', '--ci', '--skip-targets-install')
      break
    case 'build-android-apk':
      invocation = tauriArgs(service, 'android', 'build', '--debug', '--apk', '--target', 'aarch64')
      break
    case 'verify-android-apk':
      invocation = nodeScript(
        root,
        'check-tauri-artifact.mjs',
        artifact('gen', 'android', 'app', 'build', 'outputs', 'apk'),
      )
      break
    case 'build-android-aab':
      invocation = tauriArgs(service, 'android', 'build', '--debug', '--aab', '--target', 'aarch64')
      break
    case 'verify-android-aab':
      invocation = nodeScript(
        root,
        'check-tauri-artifact.mjs',
        artifact('gen', 'android', 'app', 'build', 'outputs', 'bundle'),
      )
      break
    default:
      throw new Error(`unknown native workflow action: ${String(action)}`)
  }
  return { ...invocation, cwd: root }
}

async function main() {
  const [directory, action, ...extra] = process.argv.slice(2)
  if (!directory || !action || extra.length > 0) {
    throw new Error('usage: native-workflow.mjs <catalog-service> <action>')
  }
  const services = await loadServiceCatalog(DEFAULT_ROOT)
  const service = services.find((candidate) => candidate.directory === directory)
  if (!service?.native) throw new Error(`${directory}: service is not a catalog native service`)
  const invocation = nativeWorkflowInvocation(DEFAULT_ROOT, service, action)
  execFileSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    stdio: 'inherit',
    timeout: 90 * 60 * 1_000,
    killSignal: 'SIGTERM',
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`native workflow blocked: ${error instanceof Error ? error.message : 'failure'}`)
    process.exitCode = error?.status ?? 1
  })
}
