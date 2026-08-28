#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEARCH_ROOTS = ['packages', 'services', 'scripts', '.github', 'infra']
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.wrangler',
  'node_modules',
  'dist',
  'coverage',
  'target',
  'gen',
  'playwright-report',
  'test-results',
])
const ALLOWED_TEST_KEY_FILE = 'packages/shared/test/jwt-keys.ts'
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/g

function pathName(root, path) {
  return relative(root, path).split('/').join('/')
}

function trackedFiles(root) {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(
      output
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map((path) => resolve(root, path)),
    )
  } catch {
    return null
  }
}

async function filesUnder(directory, tracked) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      files.push(resolve(directory, entry.name))
      continue
    }
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name))
        files.push(...(await filesUnder(resolve(directory, entry.name), tracked)))
    } else if (entry.isFile()) {
      const name = entry.name
      const path = resolve(directory, name)
      if (name === '.dev.vars' && !tracked?.has(path)) continue
      // A credential can be hidden in a .pem/.key/.txt or extensionless file;
      // scan every tracked-like file under the source roots rather than using
      // a source-code extension allowlist. Generated/binary-heavy directories
      // are excluded above.
      files.push(path)
    }
  }
  return files
}

async function isAllowedDocumentationSymlink(workspace, path) {
  if (basename(path) !== 'CLAUDE.md') return false
  let target
  try {
    target = await realpath(path)
  } catch {
    return false
  }
  let canonicalWorkspace
  let canonicalParent
  try {
    canonicalWorkspace = await realpath(workspace)
    canonicalParent = await realpath(dirname(path))
  } catch {
    return false
  }
  const canonicalTargetRelative = relative(canonicalWorkspace, target)
  return (
    basename(target) === 'AGENTS.md' &&
    dirname(target) === canonicalParent &&
    canonicalTargetRelative !== '' &&
    !canonicalTargetRelative.startsWith('..') &&
    !isAbsolute(canonicalTargetRelative) &&
    (await lstat(target)).isFile()
  )
}

export async function findKeyBoundaryViolations(root = process.cwd()) {
  const workspace = resolve(root)
  const tracked = trackedFiles(workspace)
  const violations = []
  for (const directory of SEARCH_ROOTS) {
    for (const path of await filesUnder(resolve(workspace, directory), tracked)) {
      if ((await lstat(path)).isSymbolicLink()) {
        if (await isAllowedDocumentationSymlink(workspace, path)) continue
        violations.push(
          `${pathName(workspace, path)}: symbolic links are forbidden in secret scan roots`,
        )
        continue
      }
      const source = await readFile(path, 'utf8')
      PRIVATE_KEY_BLOCK.lastIndex = 0
      if (PRIVATE_KEY_BLOCK.test(source) && pathName(workspace, path) !== ALLOWED_TEST_KEY_FILE) {
        violations.push(
          `${pathName(workspace, path)}: private key material is outside the test fixture allowlist`,
        )
      }
    }
  }
  return violations.sort()
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const violations = await findKeyBoundaryViolations()
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation)
    process.exitCode = 1
  } else {
    console.log('private key boundary: ok')
  }
}
