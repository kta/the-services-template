#!/usr/bin/env node

import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readJson(path, label, violations, root) {
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
    const escaped = relative(await realpath(root), resolved)
    if (
      escaped === '..' ||
      escaped.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(escaped)
    ) {
      violations.push(`${label} resolves outside the workspace`)
      return undefined
    }
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'is missing' : `has malformed JSON: ${error.message}`
    violations.push(`${label} ${reason}`)
    return undefined
  }
}

export async function validateServiceCatalog(root = DEFAULT_ROOT) {
  const violations = []
  const source = await readJson(
    join(root, 'service-catalog.json'),
    'service-catalog.json',
    violations,
    root,
  )
  const services = source?.services
  if (!Array.isArray(services)) {
    if (source) violations.push('service-catalog.json must contain a services array')
    return { services: [], violations }
  }

  const directories = new Set()
  const packages = new Set()
  for (const [index, service] of services.entries()) {
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
    if (typeof packageName !== 'string' || !/^@app\/[a-z][a-z0-9_]{0,62}$/.test(packageName)) {
      violations.push(`${directory}: invalid package ${String(packageName)}`)
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
    if (native && typeof service.nativeWorkflow !== 'string') {
      violations.push(`${directory}: native service requires nativeWorkflow`)
    }

    const packagePath = join(root, 'services', directory, 'package.json')
    const packageJson = await readJson(
      packagePath,
      `services/${directory}/package.json`,
      violations,
      root,
    )
    if (packageJson && packageJson.name !== packageName) {
      violations.push(
        `${directory}: catalog package ${String(packageName)} does not match workspace package ${String(packageJson.name)}`,
      )
    }
    if (!(await isDirectory(join(root, 'services', directory, 'src', 'web')))) {
      violations.push(`${directory}: catalog SPA service is missing services/${directory}/src/web`)
    }
  }

  let serviceEntries = []
  try {
    serviceEntries = await readdir(join(root, 'services'), { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const entry of serviceEntries) {
    if (!entry.isDirectory()) continue
    if (!(await isDirectory(join(root, 'services', entry.name, 'src', 'web')))) continue
    if (!directories.has(entry.name)) {
      violations.push(`${entry.name}: SPA workspace is missing from service-catalog.json`)
    }
  }

  return { services, violations }
}

export async function loadServiceCatalog(root = DEFAULT_ROOT) {
  const result = await validateServiceCatalog(root)
  if (result.violations.length > 0) throw new Error(result.violations.join('\n'))
  return result.services
}

function parseRoot(args) {
  const rootIndex = args.indexOf('--root')
  return rootIndex >= 0 ? resolve(args[rootIndex + 1]) : DEFAULT_ROOT
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const root = parseRoot(args)
  const { services, violations } = await validateServiceCatalog(root)
  if (violations.length > 0) {
    process.stderr.write(`${violations.join('\n')}\n`)
    process.exitCode = 1
    return
  }
  if (command === 'validate') return
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
  throw new Error('usage: service-catalog.mjs validate|list|native-manifests|require-native')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`service catalog: ${error.message}\n`)
    process.exitCode = 1
  })
}
