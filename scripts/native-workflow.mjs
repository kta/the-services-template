#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProductionPnpm, resolveReviewedNode } from './production-pnpm.mjs'
import { loadServiceCatalog } from './service-catalog.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_GUARD_ACTION = 'package-guard'
const NATIVE_TAURI_ACTIONS = new Set([
  'build-macos',
  'init-ios',
  'build-ios',
  'init-android',
  'build-android-apk',
  'build-android-aab',
])
const CAPABILITY_FILE = 'capability.json'
const CAPABILITY_MAX_AGE_MS = 5 * 60 * 1_000

function capabilityUseLimit(action) {
  return action.startsWith('build-') ? 2 : 1
}

function isInside(path, directory) {
  const relation = relative(directory, path)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

function executorContextFailure() {
  throw new Error(
    'GitHub native builds require the registered manual protected-main native executor',
  )
}

export function assertNativeWorkflowExecutorContext(workspaceRoot, service, environment) {
  if (environment?.GITHUB_ACTIONS !== 'true') return
  const repository = environment.GITHUB_REPOSITORY
  const workflowRef =
    typeof repository === 'string' && typeof service?.nativeWorkflow === 'string'
      ? `${repository}/${service.nativeWorkflow}@refs/heads/main`
      : undefined
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    environment.GITHUB_REF_PROTECTED !== 'true' ||
    environment.GITHUB_WORKFLOW_REF !== workflowRef ||
    !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID ?? '') ||
    resolve(environment.GITHUB_WORKSPACE ?? '') !== resolve(workspaceRoot)
  ) {
    executorContextFailure()
  }
}

function capabilityEnvironment(workspaceRoot, service, action, environment) {
  assertNativeWorkflowExecutorContext(workspaceRoot, service, environment)
  if (environment.GITHUB_ACTIONS !== 'true' || !NATIVE_TAURI_ACTIONS.has(action)) {
    return { environment, cleanup() {} }
  }
  const workspace = realpathSync(workspaceRoot)
  const runnerTemp = realpathSync(environment.RUNNER_TEMP ?? '')
  if (isInside(runnerTemp, workspace)) {
    throw new Error('native workflow capability directory must be outside the checkout')
  }
  const capabilityDirectory = mkdtempSync(join(runnerTemp, 'native-build-capability-'))
  const capabilityPath = join(capabilityDirectory, CAPABILITY_FILE)
  const nonce = randomBytes(32).toString('hex')
  const payload = {
    nonce,
    service: service.directory,
    action,
    runId: environment.GITHUB_RUN_ID,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
    issuerPid: process.pid,
    issuedAt: Date.now(),
    remainingUses: capabilityUseLimit(action),
  }
  writeFileSync(capabilityPath, `${JSON.stringify(payload)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  return {
    environment: {
      ...environment,
      NATIVE_WORKFLOW_SERVICE: service.directory,
      NATIVE_WORKFLOW_ACTION: action,
      NATIVE_WORKFLOW_CAPABILITY_PATH: capabilityPath,
      NATIVE_WORKFLOW_CAPABILITY_NONCE: nonce,
    },
    cleanup() {
      rmSync(capabilityDirectory, { recursive: true, force: true })
    },
  }
}

function secureCapabilityFile(path, runnerTemp, workspaceRoot) {
  if (!isAbsolute(path) || basename(path) !== CAPABILITY_FILE) {
    throw new Error('native workflow package-build capability path is invalid')
  }
  const workspace = realpathSync(workspaceRoot)
  const runner = realpathSync(runnerTemp)
  const directory = realpathSync(dirname(path))
  if (!isInside(directory, runner) || isInside(directory, workspace)) {
    throw new Error('native workflow package-build capability must be outside the checkout')
  }
  const directoryInfo = lstatSync(directory)
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) {
    throw new Error('native workflow package-build capability directory must be owner-only')
  }
  const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
  const info = fstatSync(descriptor)
  const currentUser = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (info.mode & 0o077) !== 0 ||
    (currentUser !== undefined && info.uid !== currentUser)
  ) {
    closeSync(descriptor)
    throw new Error('native workflow package-build capability file must be owner-only')
  }
  return descriptor
}

function consumeNativePackageBuildCapability(workspaceRoot, service, environment) {
  if (environment.GITHUB_ACTIONS !== 'true') return
  assertNativeWorkflowExecutorContext(workspaceRoot, service, environment)
  const path = environment.NATIVE_WORKFLOW_CAPABILITY_PATH
  const nonce = environment.NATIVE_WORKFLOW_CAPABILITY_NONCE
  if (typeof path !== 'string' || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) {
    throw new Error('native workflow package-build capability is required')
  }
  let descriptor
  let removeCapability = false
  try {
    descriptor = secureCapabilityFile(path, environment.RUNNER_TEMP ?? '', workspaceRoot)
    const payload = JSON.parse(readFileSync(descriptor, 'utf8'))
    const issuedAt = Number(payload.issuedAt)
    const remainingUses = Number(payload.remainingUses)
    if (
      payload.nonce !== nonce ||
      payload.service !== service.directory ||
      payload.action !== environment.NATIVE_WORKFLOW_ACTION ||
      !NATIVE_TAURI_ACTIONS.has(payload.action) ||
      environment.NATIVE_WORKFLOW_SERVICE !== service.directory ||
      payload.runId !== environment.GITHUB_RUN_ID ||
      payload.workflowRef !== environment.GITHUB_WORKFLOW_REF ||
      !Number.isSafeInteger(payload.issuerPid) ||
      !Number.isFinite(issuedAt) ||
      !Number.isSafeInteger(remainingUses) ||
      remainingUses < 1 ||
      remainingUses > capabilityUseLimit(payload.action) ||
      issuedAt > Date.now() + 10_000 ||
      Date.now() - issuedAt > CAPABILITY_MAX_AGE_MS
    ) {
      throw new Error('native workflow package-build capability does not match this executor')
    }
    try {
      process.kill(payload.issuerPid, 0)
    } catch {
      throw new Error('native workflow package-build capability issuer is no longer running')
    }
    if (remainingUses === 1) {
      removeCapability = true
    } else {
      const nextPayload = `${JSON.stringify({ ...payload, remainingUses: remainingUses - 1 })}\n`
      ftruncateSync(descriptor, 0)
      writeSync(descriptor, nextPayload, 0, 'utf8')
      fsyncSync(descriptor)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  if (removeCapability) unlinkSync(path)
}

async function guardNativePackageBuild() {
  const services = await loadServiceCatalog(DEFAULT_ROOT)
  const cwd = realpathSync(process.cwd())
  const service = services.find(
    (candidate) =>
      candidate.native && realpathSync(join(DEFAULT_ROOT, 'services', candidate.directory)) === cwd,
  )
  if (!service) throw new Error('native package guard must run from a catalog native service')
  consumeNativePackageBuildCapability(DEFAULT_ROOT, service, process.env)
}

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
    args: ['--filter', service.package, 'run', 'tauri', ...args],
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
  'GITHUB_EVENT_NAME',
  'GITHUB_REF',
  'GITHUB_REF_PROTECTED',
  'GITHUB_REPOSITORY',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_RUN_ID',
  'GITHUB_WORKSPACE',
  'RUNNER_TEMP',
  'NATIVE_WORKFLOW_SERVICE',
  'NATIVE_WORKFLOW_ACTION',
  'NATIVE_WORKFLOW_CAPABILITY_PATH',
  'NATIVE_WORKFLOW_CAPABILITY_NONCE',
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
  if (
    child.NDK_HOME === undefined &&
    androidHome &&
    typeof child.ANDROID_NDK_VERSION === 'string'
  ) {
    child.NDK_HOME = join(androidHome, 'ndk', child.ANDROID_NDK_VERSION)
  }
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
  if (directory === PACKAGE_GUARD_ACTION && action === undefined && extra.length === 0) {
    await guardNativePackageBuild()
    return
  }
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
  const capability = capabilityEnvironment(DEFAULT_ROOT, service, action, process.env)
  try {
    execFileSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: nativeWorkflowChildEnvironment(capability.environment, options),
      stdio: 'inherit',
      timeout: 90 * 60 * 1_000,
      killSignal: 'SIGTERM',
    })
  } finally {
    capability.cleanup()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`native workflow blocked: ${error instanceof Error ? error.message : 'failure'}`)
    process.exitCode = error?.status ?? 1
  })
}
