import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from 'node:path'

const PNPM_EXECUTABLE_PATTERN = /^pnpm(?:\.c?js)?$/

function isInside(path, directory) {
  const relation = relative(directory, path)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

/**
 * Resolve the pnpm executable used by a credentialed production helper.
 *
 * The workflow captures an absolute path before credentials are exposed. A
 * local operator may provide the same path through PRODUCTION_PNPM_PATH, but
 * it must resolve to a non-writable, executable pnpm file owned by root or
 * the current user, outside this checkout. Invalid overrides fail closed
 * instead of silently falling back to PATH.
 */
export function resolveProductionPnpm(env = process.env, workspaceRoot = process.cwd()) {
  const configured = env.PRODUCTION_PNPM_PATH
  const configuredPath =
    configured === undefined
      ? findPathPnpm(env.PATH)
      : (() => {
          if (typeof configured !== 'string' || !isAbsolute(configured)) {
            throw new Error('PRODUCTION_PNPM_PATH must be an absolute path')
          }
          return configured
        })()
  return validateExecutable(configuredPath, workspaceRoot)
}

function findPathPnpm(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    throw new Error('PATH must contain a trusted pnpm executable')
  }
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    for (const name of ['pnpm', 'pnpm.js', 'pnpm.cjs']) {
      const candidate = resolve(directory, name)
      try {
        lstatSync(candidate)
      } catch {
        continue
      }
      return candidate
    }
  }
  throw new Error('PATH must contain a trusted pnpm executable')
}

function validateExecutable(configuredPath, workspaceRoot) {
  const checkout = realpathSync(resolve(workspaceRoot))
  if (isInside(resolve(configuredPath), checkout)) {
    throw new Error('pnpm must not point inside the repository checkout')
  }
  let executable
  try {
    executable = realpathSync(configuredPath)
  } catch {
    throw new Error('pnpm must resolve to an existing executable')
  }
  const info = lstatSync(executable)
  if (!info.isFile() || (info.mode & 0o022) !== 0) {
    throw new Error('pnpm must resolve to a non-writable regular file')
  }
  try {
    accessSync(executable, constants.X_OK)
  } catch {
    throw new Error('pnpm must resolve to an executable file')
  }
  if (!PNPM_EXECUTABLE_PATTERN.test(basename(executable))) {
    throw new Error('pnpm must resolve to a pnpm executable')
  }

  const currentUser = typeof process.getuid === 'function' ? process.getuid() : null
  if (currentUser !== null && info.uid !== 0 && info.uid !== currentUser) {
    throw new Error('pnpm must be owned by root or the current user')
  }
  const parent = lstatSync(dirname(executable))
  if (
    !parent.isDirectory() ||
    (parent.mode & 0o022) !== 0 ||
    (currentUser !== null && parent.uid !== 0 && parent.uid !== currentUser)
  ) {
    throw new Error('pnpm parent directory must be owner-only and trusted')
  }
  if (isInside(executable, checkout)) {
    throw new Error('pnpm must not point inside the repository checkout')
  }
  return executable
}
