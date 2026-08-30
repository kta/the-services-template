#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProductionPnpm, resolveReviewedNode } from './production-pnpm.mjs'
import { loadServiceCatalog } from './service-catalog.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function reviewedTool(options, name) {
  const path = options?.[name]
  const pattern = name === 'nodePath' ? /^node(?:\.exe)?$/ : /^pnpm(?:\.c?js)?$/
  if (typeof path !== 'string' || !isAbsolute(path) || !pattern.test(basename(path))) {
    throw new Error(`native workflow requires a reviewed absolute ${name}`)
  }
  return path
}

function tauriArgs(service, options, ...args) {
  return {
    command: reviewedTool(options, 'pnpmPath'),
    args: ['--filter', service.package, 'exec', 'tauri', ...args],
  }
}

function nodeScript(root, options, script, ...args) {
  return {
    command: reviewedTool(options, 'nodePath'),
    args: [join(root, 'scripts', script), ...args],
  }
}

export function nativeWorkflowInvocation(workspaceRoot, service, action, options = {}) {
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
      invocation = nodeScript(root, options, 'check-tauri-boundary.mjs')
      break
    case 'build-macos':
      invocation = tauriArgs(
        service,
        options,
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
        options,
        'check-tauri-artifact.mjs',
        artifact('target', 'universal-apple-darwin', 'debug', 'bundle', 'macos'),
      )
      break
    case 'init-ios':
      invocation = tauriArgs(service, options, 'ios', 'init', '--ci', '--skip-targets-install')
      break
    case 'build-ios':
      invocation = tauriArgs(
        service,
        options,
        'ios',
        'build',
        '--debug',
        '--target',
        'aarch64-sim',
        '--no-sign',
      )
      break
    case 'verify-ios':
      invocation = nodeScript(
        root,
        options,
        'check-tauri-artifact.mjs',
        artifact('gen', 'apple', 'build'),
      )
      break
    case 'init-android':
      invocation = tauriArgs(service, options, 'android', 'init', '--ci', '--skip-targets-install')
      break
    case 'build-android-apk':
      invocation = tauriArgs(
        service,
        options,
        'android',
        'build',
        '--debug',
        '--apk',
        '--target',
        'aarch64',
      )
      break
    case 'verify-android-apk':
      invocation = nodeScript(
        root,
        options,
        'check-tauri-artifact.mjs',
        artifact('gen', 'android', 'app', 'build', 'outputs', 'apk'),
      )
      break
    case 'build-android-aab':
      invocation = tauriArgs(
        service,
        options,
        'android',
        'build',
        '--debug',
        '--aab',
        '--target',
        'aarch64',
      )
      break
    case 'verify-android-aab':
      invocation = nodeScript(
        root,
        options,
        'check-tauri-artifact.mjs',
        artifact('gen', 'android', 'app', 'build', 'outputs', 'bundle'),
      )
      break
    default:
      throw new Error(`unknown native workflow action: ${String(action)}`)
  }
  return { ...invocation, cwd: root }
}

const NATIVE_ENVIRONMENT = new Set([
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
  'GITHUB_ACTIONS',
  'GITHUB_WORKSPACE',
  'RUNNER_TEMP',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'NDK_HOME',
  'JAVA_HOME',
  'JAVA_HOME_17_X64',
  'DEVELOPER_DIR',
  'SDKROOT',
  'MACOSX_DEPLOYMENT_TARGET',
  'ANDROID_PLATFORM_API',
  'ANDROID_NDK_VERSION',
  'XCODEGEN_VERSION',
])

export function nativeWorkflowChildEnvironment(environment, options) {
  const child = Object.fromEntries(
    Object.entries(environment ?? {}).filter(([name]) => NATIVE_ENVIRONMENT.has(name)),
  )
  const nodePath = reviewedTool(options, 'nodePath')
  const pnpmPath = reviewedTool(options, 'pnpmPath')
  const home = typeof child.HOME === 'string' ? child.HOME : undefined
  const cargoHome =
    typeof child.CARGO_HOME === 'string' ? child.CARGO_HOME : home && join(home, '.cargo')
  const androidHome =
    typeof child.ANDROID_HOME === 'string' ? child.ANDROID_HOME : child.ANDROID_SDK_ROOT
  const directories = [
    dirname(nodePath),
    dirname(pnpmPath),
    cargoHome && join(cargoHome, 'bin'),
    androidHome && join(androidHome, 'platform-tools'),
    androidHome && join(androidHome, 'cmdline-tools', 'latest', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter((directory, index, values) => directory && values.indexOf(directory) === index)
  child.PATH = directories.join(delimiter)
  return child
}

async function main() {
  const [directory, action, ...extra] = process.argv.slice(2)
  if (!directory || !action || extra.length > 0) {
    throw new Error('usage: native-workflow.mjs <catalog-service> <action>')
  }
  const services = await loadServiceCatalog(DEFAULT_ROOT)
  const service = services.find((candidate) => candidate.directory === directory)
  if (!service?.native) throw new Error(`${directory}: service is not a catalog native service`)
  const options = {
    nodePath: resolveReviewedNode(process.execPath, DEFAULT_ROOT),
    pnpmPath: resolveProductionPnpm(process.env, DEFAULT_ROOT),
  }
  const invocation = nativeWorkflowInvocation(DEFAULT_ROOT, service, action, options)
  execFileSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: nativeWorkflowChildEnvironment(process.env, options),
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
