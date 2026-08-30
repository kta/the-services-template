#!/usr/bin/env node

import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function isInside(root, path) {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

async function safeDirectory(path, label, containmentRoot, violations) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      violations.push(`${label} must be a regular directory, not a symbolic link`)
      return undefined
    }
    if (!info.isDirectory()) {
      violations.push(`${label} must be a regular directory`)
      return undefined
    }
    const resolved = await realpath(path)
    if (!isInside(containmentRoot, resolved)) {
      violations.push(`${label} resolves outside its allowed root`)
      return undefined
    }
    return resolved
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'is missing' : `cannot be inspected: ${error.message}`
    violations.push(`${label} ${reason}`)
    return undefined
  }
}

async function readJson(path, label, violations, containmentRoot) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      violations.push(`${label} must be a regular file, not a symbolic link`)
      return undefined
    }
    if (!info.isFile()) {
      violations.push(`${label} must be a regular file`)
      return undefined
    }
    const resolved = await realpath(path)
    if (!isInside(containmentRoot, resolved)) {
      violations.push(`${label} resolves outside its allowed root`)
      return undefined
    }
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'is missing' : `has malformed JSON: ${error.message}`
    violations.push(`${label} ${reason}`)
    return undefined
  }
}

async function readRegularFile(path, label, violations, containmentRoot) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      violations.push(`${label} must be a regular file, not a symbolic link`)
      return undefined
    }
    if (!info.isFile()) {
      violations.push(`${label} must be a regular file`)
      return undefined
    }
    const resolved = await realpath(path)
    if (!isInside(containmentRoot, resolved)) {
      violations.push(`${label} resolves outside its allowed root`)
      return undefined
    }
    return await readFile(resolved, 'utf8')
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'is missing' : `cannot be inspected: ${error.message}`
    violations.push(`${label} ${reason}`)
    return undefined
  }
}

function validateNativeWorkflowPolicy(path, source, violations) {
  if (!/\bworkflow_dispatch\s*:/.test(source))
    violations.push(`${path}: native workflow must be manual-only with workflow_dispatch`)
  const onBlock = source.match(/^on:\s*\n((?:[ \t].*(?:\n|$))*)/m)?.[1] ?? ''
  const automaticTriggers = [
    ...onBlock.matchAll(
      /^ {2}(push|pull_request|schedule|workflow_call|repository_dispatch|merge_group):/gm,
    ),
  ].map((match) => match[1])
  if (automaticTriggers.length > 0)
    violations.push(
      `${path}: native workflow must be manual-only; remove ${automaticTriggers.join(', ')}`,
    )
  const jobsStart = source.search(/^jobs:\s*$/m)
  const jobsSource = jobsStart < 0 ? '' : source.slice(jobsStart)
  const jobStarts = [...jobsSource.matchAll(/^ {2}[A-Za-z0-9_-]+:\s*$/gm)]
  const protectedMain =
    /github\.event_name == 'workflow_dispatch'[^\n]*github\.ref == 'refs\/heads\/main'[^\n]*github\.ref_protected == true/
  if (
    jobStarts.length === 0 ||
    jobStarts.some((job, index) => {
      const start = job.index ?? 0
      const end = jobStarts[index + 1]?.index
      return !protectedMain.test(jobsSource.slice(start, end))
    })
  )
    violations.push(`${path}: every native workflow job must require protected main`)
  if (
    /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_|\bwrangler\s+deploy\b|id-token:\s*write/.test(
      source,
    )
  )
    violations.push(
      `${path}: native workflow must not receive a Cloudflare credential or production capability`,
    )
  if (!/check-tauri-boundary\.mjs/.test(source))
    violations.push(`${path}: native workflow must run the Tauri boundary checker`)
  if (!/check-tauri-artifact\.mjs/.test(source))
    violations.push(`${path}: native workflow must run the Tauri artifact checker`)
  for (const pin of [
    /ANDROID_PLATFORM_API:\s*35/,
    /ANDROID_NDK_VERSION:\s*27\.2\.12479018/,
    /XCODEGEN_VERSION:\s*2\.46\.0/,
  ]) {
    if (!pin.test(source))
      violations.push(
        `${path}: native workflow is missing required platform pin ${pin.source.split(':')[0]}`,
      )
  }
}

export async function validateServiceCatalog(root = DEFAULT_ROOT) {
  const violations = []
  const workspace = resolve(root)
  const workspaceReal = await realpath(workspace)
  const source = await readJson(
    join(workspace, 'service-catalog.json'),
    'service-catalog.json',
    violations,
    workspaceReal,
  )
  if (source === undefined) return { services: [], workerOnlyServices: [], violations }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    violations.push('service-catalog.json must contain an object')
    return { services: [], workerOnlyServices: [], violations }
  }
  const services = source.services
  if (!Array.isArray(services)) {
    if (source) violations.push('service-catalog.json must contain a services array')
    return { services: [], workerOnlyServices: [], violations }
  }
  const rawWorkerOnlyServices = source.workerOnlyServices ?? []
  const workerOnlyServices = []
  if (!Array.isArray(rawWorkerOnlyServices)) {
    violations.push('service-catalog.json workerOnlyServices must be an array')
  } else {
    for (const [index, directory] of rawWorkerOnlyServices.entries()) {
      if (typeof directory !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(directory)) {
        violations.push(`service-catalog.json workerOnlyServices[${index}] has invalid directory`)
      } else if (workerOnlyServices.includes(directory)) {
        violations.push(`${directory}: duplicate worker-only service`)
      } else {
        workerOnlyServices.push(directory)
      }
    }
  }

  const servicesRoot = join(workspace, 'services')
  const servicesReal = await safeDirectory(servicesRoot, 'services', workspaceReal, violations)
  if (!servicesReal) return { services: [], workerOnlyServices, violations }

  const directories = new Set()
  const packages = new Set()
  const workflowPaths = new Set()
  const normalizedServices = []
  for (const [index, service] of services.entries()) {
    const violationCount = violations.length
    const label = `service-catalog.json services[${index}]`
    if (!service || typeof service !== 'object') {
      violations.push(`${label} must be an object`)
      continue
    }
    const { directory, package: packageName, templateKind, deployable, native } = service
    if (typeof directory !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(directory)) {
      violations.push(`${label} has invalid directory ${String(directory)}`)
      continue
    }
    if (directories.has(directory)) violations.push(`${directory}: duplicate catalog directory`)
    directories.add(directory)
    if (packageName !== `@app/${directory}`) {
      violations.push(`${directory}: package must be exactly @app/${directory}`)
    } else {
      if (packages.has(packageName))
        violations.push(`${directory}: duplicate package ${packageName}`)
      packages.add(packageName)
    }
    if (!['web', 'tauri'].includes(templateKind)) {
      violations.push(`${directory}: templateKind must be web or tauri`)
    }
    if (typeof deployable !== 'boolean') violations.push(`${directory}: deployable must be boolean`)
    if (typeof native !== 'boolean') violations.push(`${directory}: native must be boolean`)
    if (templateKind === 'web' && native !== false) {
      violations.push(`${directory}: templateKind web requires native false`)
    }
    if (templateKind === 'tauri' && native !== true) {
      violations.push(`${directory}: templateKind tauri requires native true`)
    }
    if (native === true && typeof service.nativeWorkflow !== 'string') {
      violations.push(`${directory}: native service requires nativeWorkflow`)
    }
    if (native === false && Object.hasOwn(service, 'nativeWorkflow')) {
      violations.push(`${directory}: non-native service must not declare nativeWorkflow`)
    }
    if (native === true && typeof service.nativeWorkflow === 'string') {
      if (
        !/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(service.nativeWorkflow)
      ) {
        violations.push(
          `${directory}: nativeWorkflow must be a safe .github/workflows/*.yml or *.yaml path`,
        )
      } else if (workflowPaths.has(service.nativeWorkflow)) {
        violations.push(`${directory}: duplicate nativeWorkflow ${service.nativeWorkflow}`)
      } else {
        workflowPaths.add(service.nativeWorkflow)
      }
    }

    if (violations.length !== violationCount) continue

    const serviceRoot = join(servicesRoot, directory)
    const serviceReal = await safeDirectory(
      serviceRoot,
      `services/${directory}`,
      servicesReal,
      violations,
    )
    if (!serviceReal) continue

    const packagePath = join(serviceRoot, 'package.json')
    const packageJson = await readJson(
      packagePath,
      `services/${directory}/package.json`,
      violations,
      serviceReal,
    )
    if (packageJson && packageJson.name !== packageName) {
      violations.push(
        `${directory}: catalog package ${String(packageName)} does not match workspace package ${String(packageJson.name)}`,
      )
    }
    await safeDirectory(
      join(serviceRoot, 'src', 'web'),
      `services/${directory}/src/web`,
      serviceReal,
      violations,
    )
    if (native) {
      const workflowSource = await readRegularFile(
        join(workspace, service.nativeWorkflow),
        service.nativeWorkflow,
        violations,
        workspaceReal,
      )
      if (workflowSource !== undefined) {
        validateNativeWorkflowPolicy(service.nativeWorkflow, workflowSource, violations)
        if (!workflowSource.includes(packageName))
          violations.push(`${service.nativeWorkflow}: must reference ${packageName}`)
        if (!workflowSource.includes(`services/${directory}/src-tauri`))
          violations.push(
            `${service.nativeWorkflow}: must reference services/${directory}/src-tauri`,
          )
      }
    }
    if (violations.length !== violationCount) continue

    normalizedServices.push({
      directory,
      package: packageName,
      templateKind,
      deployable,
      native,
      ...(native ? { nativeWorkflow: service.nativeWorkflow } : {}),
    })
  }

  for (const directory of workerOnlyServices) {
    if (directories.has(directory))
      violations.push(`${directory}: service cannot be both SPA and worker-only`)
  }

  const serviceEntries = await readdir(servicesRoot, { withFileTypes: true })
  for (const entry of serviceEntries) {
    if (entry.isSymbolicLink()) {
      violations.push(`services/${entry.name} must not be a symbolic link`)
      continue
    }
    if (!entry.isDirectory()) continue
    const webPath = join(servicesRoot, entry.name, 'src', 'web')
    let webInfo
    try {
      webInfo = await lstat(webPath)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      violations.push(`services/${entry.name}/src/web cannot be inspected: ${error.message}`)
      continue
    }
    if (webInfo.isSymbolicLink()) {
      violations.push(`services/${entry.name}/src/web must not be a symbolic link`)
      continue
    }
    if (!webInfo.isDirectory()) continue
    if (!directories.has(entry.name)) {
      violations.push(`${entry.name}: SPA workspace is missing from service-catalog.json`)
    }
  }

  const workflowsRoot = join(workspace, '.github', 'workflows')
  try {
    const workflowEntries = await readdir(workflowsRoot, { withFileTypes: true })
    for (const entry of workflowEntries) {
      if (!/\.ya?ml$/.test(entry.name)) continue
      const workflowPath = `.github/workflows/${entry.name}`
      if (entry.isSymbolicLink()) {
        if (!workflowPaths.has(workflowPath))
          violations.push(`${workflowPath}: workflow must not be a symbolic link`)
        continue
      }
      if (!entry.isFile() || workflowPaths.has(workflowPath)) continue
      const source = await readRegularFile(
        join(workflowsRoot, entry.name),
        workflowPath,
        violations,
        workspaceReal,
      )
      if (source && /check-tauri-artifact\.mjs|\btauri\s+(?:build|ios|android)\b/.test(source)) {
        violations.push(
          `${workflowPath}: native workflow is not registered as a catalog nativeWorkflow`,
        )
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT')
      violations.push(`.github/workflows cannot be inspected: ${error.message}`)
  }

  return { services: normalizedServices, workerOnlyServices, violations }
}

export async function loadServiceCatalog(root = DEFAULT_ROOT) {
  const result = await validateServiceCatalog(root)
  if (result.violations.length > 0) throw new Error(result.violations.join('\n'))
  return result.services
}

export async function loadServiceRepositoryCatalog(root = DEFAULT_ROOT) {
  const result = await validateServiceCatalog(root)
  if (result.violations.length > 0) throw new Error(result.violations.join('\n'))
  return { services: result.services, workerOnlyServices: result.workerOnlyServices }
}

function parseRoot(args) {
  const rootIndex = args.indexOf('--root')
  return rootIndex >= 0 ? resolve(args[rootIndex + 1]) : DEFAULT_ROOT
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const root = parseRoot(args)
  const { services, workerOnlyServices, violations } = await validateServiceCatalog(root)
  if (violations.length > 0) {
    process.stderr.write(`${violations.join('\n')}\n`)
    process.exitCode = 1
    return
  }
  if (command === 'validate') return
  if (command === 'validate-repository') {
    const { validateServiceWiring } = await import('./service-wiring.mjs')
    const wiringViolations = await validateServiceWiring(root, { services, workerOnlyServices })
    if (wiringViolations.length > 0) {
      process.stderr.write(`${wiringViolations.join('\n')}\n`)
      process.exitCode = 1
    }
    return
  }
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(services)}\n`)
    return
  }
  if (command === 'native-manifests') {
    const manifests = services
      .filter((service) => service.native)
      .map((service) => `services/${service.directory}/src-tauri/Cargo.toml`)
    process.stdout.write(
      args.includes('--json') ? `${JSON.stringify(manifests)}\n` : `${manifests.join('\n')}\n`,
    )
    return
  }
  if (command === 'require-native') {
    const directory = args[1]
    const service = services.find((candidate) => candidate.directory === directory)
    if (!service) throw new Error(`${directory}: service is not registered in service-catalog.json`)
    if (!service.native) {
      throw new Error(`${directory}: Web-only service cannot run native Tauri commands`)
    }
    return
  }
  if (command === 'native-selector') {
    const directory = args[1]
    const service = services.find((candidate) => candidate.directory === directory)
    if (!service) throw new Error(`${directory}: service is not registered in service-catalog.json`)
    if (!service.native) {
      throw new Error(`${directory}: Web-only service cannot run native Tauri commands`)
    }
    process.stdout.write(`${service.package}\n`)
    return
  }
  throw new Error(
    'usage: service-catalog.mjs validate|validate-repository|list|native-manifests|require-native|native-selector',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`service catalog: ${error.message}\n`)
    process.exitCode = 1
  })
}
