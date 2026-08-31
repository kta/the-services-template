import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

const NATIVE_BOUNDARY_MANIFEST = 'tauri-boundary.json'

function isInside(root, path) {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value, required, optional, label, violations) {
  if (!isObject(value)) {
    violations.push(`${label} must be an object`)
    return false
  }
  const allowed = new Set([...required, ...optional])
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) violations.push(`${label} has unknown field ${field}`)
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) violations.push(`${label} is missing required field ${field}`)
  }
  return true
}

function canonicalHttpsOrigin(value) {
  if (typeof value !== 'string' || value === '' || value.endsWith('/')) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin !== value
    ) {
      return undefined
    }
    return value
  } catch {
    return undefined
  }
}

function storageKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)
    ? value
    : undefined
}

async function regularContainedFile(path, label, containmentRoot, violations) {
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
      violations.push(`${label} resolves outside its reviewed service boundary`)
      return undefined
    }
    return resolved
  } catch (error) {
    const reason =
      error?.code === 'ENOENT' ? 'is required' : `cannot be inspected: ${error.message}`
    violations.push(`${label} ${reason}`)
    return undefined
  }
}

function normalizedService(service) {
  return (
    service?.native === true &&
    typeof service.directory === 'string' &&
    /^[a-z][a-z0-9_]{0,62}$/.test(service.directory) &&
    service.package === `@app/${service.directory}`
  )
}

export async function validateNativeBoundaryManifest(workspaceRoot, service) {
  const violations = []
  if (!normalizedService(service)) {
    return {
      manifest: undefined,
      violations: ['native boundary manifest requires a normalized catalog native service'],
    }
  }

  const workspace = resolve(workspaceRoot)
  const workspaceReal = await realpath(workspace)
  const serviceLabel = `services/${service.directory}`
  const servicePath = join(workspace, serviceLabel)
  let serviceReal
  try {
    const info = await lstat(servicePath)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      violations.push(`${serviceLabel} must be a regular service directory`)
      return { manifest: undefined, violations }
    }
    serviceReal = await realpath(servicePath)
    if (!isInside(workspaceReal, serviceReal)) {
      violations.push(`${serviceLabel} resolves outside the workspace`)
      return { manifest: undefined, violations }
    }
  } catch (error) {
    violations.push(`${serviceLabel} cannot be inspected: ${error.message}`)
    return { manifest: undefined, violations }
  }

  const manifestLabel = `${serviceLabel}/${NATIVE_BOUNDARY_MANIFEST}`
  const manifestPath = await regularContainedFile(
    join(serviceReal, NATIVE_BOUNDARY_MANIFEST),
    manifestLabel,
    serviceReal,
    violations,
  )
  if (!manifestPath) return { manifest: undefined, violations }

  let source
  try {
    source = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    violations.push(`${manifestLabel} is malformed JSON: ${error.message}`)
    return { manifest: undefined, violations }
  }
  if (!exactFields(source, ['releaseOrigin', 'browserStorage'], [], manifestLabel, violations)) {
    return { manifest: undefined, violations }
  }

  const releaseOrigin = canonicalHttpsOrigin(source.releaseOrigin)
  if (!releaseOrigin) {
    violations.push(`${manifestLabel} releaseOrigin must be one canonical HTTPS origin`)
  }
  if (!Array.isArray(source.browserStorage)) {
    violations.push(`${manifestLabel} browserStorage must be an explicit array`)
    return { manifest: undefined, violations }
  }

  const webRoot = join(serviceReal, 'src', 'web')
  const storageAllowlist = new Map()
  const entries = []
  for (const [index, entry] of source.browserStorage.entries()) {
    const label = `${manifestLabel} browserStorage[${index}]`
    const validObject = exactFields(
      entry,
      ['path', 'tokenKey', 'reason'],
      ['organizationKey', 'logoutIntentKey'],
      label,
      violations,
    )
    if (!validObject) continue

    const safePath =
      typeof entry.path === 'string' &&
      /^src\/web\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:[cm]?[jt]sx?)$/.test(entry.path) &&
      !entry.path.split('/').includes('..')
    if (!safePath) {
      violations.push(`${label} path must be an exact source file below src/web`)
      continue
    }
    const sourcePath = resolve(serviceReal, entry.path)
    if (!isInside(webRoot, sourcePath)) {
      violations.push(`${label} path resolves outside src/web`)
      continue
    }
    await regularContainedFile(sourcePath, `${serviceLabel}/${entry.path}`, webRoot, violations)

    const tokenKey = storageKey(entry.tokenKey)
    if (!tokenKey) violations.push(`${label} tokenKey must be one exact browser storage key`)
    const organizationKey =
      entry.organizationKey === undefined ? undefined : storageKey(entry.organizationKey)
    if (entry.organizationKey !== undefined && !organizationKey) {
      violations.push(`${label} organizationKey must be one exact browser storage key`)
    }
    const logoutIntentKey =
      entry.logoutIntentKey === undefined ? undefined : storageKey(entry.logoutIntentKey)
    if (entry.logoutIntentKey !== undefined && !logoutIntentKey) {
      violations.push(`${label} logoutIntentKey must be one exact browser storage key`)
    }
    const keys = [tokenKey, organizationKey, logoutIntentKey].filter(Boolean)
    if (new Set(keys).size !== keys.length) {
      violations.push(`${label} browser storage keys must be distinct`)
    }
    if (
      typeof entry.reason !== 'string' ||
      entry.reason.trim() !== entry.reason ||
      entry.reason.length < 24 ||
      entry.reason.length > 240 ||
      /[\r\n]/.test(entry.reason)
    ) {
      violations.push(`${label} reason must be an explicit single-line review rationale`)
    }

    const fullPath = `${serviceLabel}/${entry.path}`
    if (storageAllowlist.has(fullPath))
      violations.push(`${label} duplicates reviewed path ${entry.path}`)
    if (
      tokenKey &&
      (entry.organizationKey === undefined || organizationKey) &&
      (entry.logoutIntentKey === undefined || logoutIntentKey) &&
      typeof entry.reason === 'string'
    ) {
      const normalized = {
        path: entry.path,
        tokenKey,
        ...(organizationKey ? { organizationKey } : {}),
        ...(logoutIntentKey ? { logoutIntentKey } : {}),
        reason: entry.reason,
      }
      entries.push(normalized)
      storageAllowlist.set(fullPath, {
        key: tokenKey,
        ...(organizationKey ? { organizationKey } : {}),
        ...(logoutIntentKey ? { logoutIntentKey } : {}),
        reason: entry.reason,
      })
    }
  }

  if (violations.length > 0 || !releaseOrigin) return { manifest: undefined, violations }
  return {
    manifest: {
      path: manifestLabel,
      releaseOrigin,
      browserStorage: entries,
      storageAllowlist,
    },
    violations,
  }
}

export async function loadNativeBoundaryManifest(workspaceRoot, service) {
  const result = await validateNativeBoundaryManifest(workspaceRoot, service)
  if (result.violations.length > 0 || !result.manifest) {
    throw new Error(result.violations.join('\n') || 'native boundary manifest is invalid')
  }
  return result.manifest
}
