import { execFileSync } from 'node:child_process'
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

const WRANGLER_EXECUTABLE_PATTERN = /^wrangler(?:\.c?js)?$/

function isInside(path, directory) {
  const relation = relative(directory, path)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

/**
 * Resolve a Wrangler executable that is outside the checkout and cannot be
 * modified by repository contents. This legacy guarded-wrapper path is kept
 * for tests and explicitly approved integrations; the shipped production
 * workflows use the lockfile-pinned offline Wrangler command directly.
 */
export function resolveProductionWrangler(env = process.env, workspaceRoot = process.cwd()) {
  const configured = env.PRODUCTION_WRANGLER_PATH
  if (typeof configured !== 'string' || !isAbsolute(configured)) {
    throw new Error('PRODUCTION_WRANGLER_PATH must be an absolute path to pinned Wrangler')
  }
  return validateExecutable(configured, workspaceRoot)
}

export function runProductionWrangler(args, options = {}, env = process.env) {
  const executable = resolveProductionWrangler(env, options.workspaceRoot ?? process.cwd())
  return execFileSync(executable, args, {
    cwd: options.cwd,
    env: options.env ?? env,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding,
    input: options.input,
    timeout: options.timeout,
    killSignal: options.killSignal,
  })
}

function validateExecutable(configuredPath, workspaceRoot) {
  const checkout = realpathSync(resolve(workspaceRoot))
  if (isInside(resolve(configuredPath), checkout)) {
    throw new Error('Wrangler must not point inside the repository checkout')
  }
  let executable
  try {
    executable = realpathSync(configuredPath)
  } catch {
    throw new Error('Wrangler must resolve to an existing executable')
  }
  const info = lstatSync(executable)
  if (!info.isFile() || (info.mode & 0o022) !== 0) {
    throw new Error('Wrangler must resolve to a non-writable regular file')
  }
  try {
    accessSync(executable, constants.X_OK)
  } catch {
    throw new Error('Wrangler must resolve to an executable file')
  }
  if (!WRANGLER_EXECUTABLE_PATTERN.test(basename(executable))) {
    throw new Error('Wrangler must resolve to a pinned Wrangler executable')
  }
  const currentUser = typeof process.getuid === 'function' ? process.getuid() : null
  if (currentUser !== null && info.uid !== 0 && info.uid !== currentUser) {
    throw new Error('Wrangler must be owned by root or the current user')
  }
  const parent = lstatSync(dirname(executable))
  if (
    !parent.isDirectory() ||
    (parent.mode & 0o022) !== 0 ||
    (currentUser !== null && parent.uid !== 0 && parent.uid !== currentUser)
  ) {
    throw new Error('Wrangler parent directory must be owner-only and trusted')
  }
  if (isInside(executable, checkout)) {
    throw new Error('Wrangler must not point inside the repository checkout')
  }
  return executable
}
