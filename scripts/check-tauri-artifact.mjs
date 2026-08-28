#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORBIDDEN_SECRET_MARKERS, forbiddenSecretMarkersInText } from './secret-boundary.mjs'

const ARCHIVE_EXTENSIONS = new Set(['.aar', '.aab', '.apk', '.ipa', '.jar', '.zip'])
// These formats may contain the same native bundle but are not safely
// inspectable with the allowlisted `unzip` path. Fail closed instead of
// treating an opaque installer/compressed file as an ordinary text file.
const UNSUPPORTED_ARCHIVE_EXTENSIONS = new Set([
  '.7z',
  '.appimage',
  '.bz2',
  '.cab',
  '.dmg',
  '.gz',
  '.msi',
  '.pkg',
  '.rar',
  '.tar',
  '.tgz',
  '.xz',
  '.zst',
])
// Generic secret-name patterns contain an unbounded identifier segment. Keep
// enough overlap for normal environment names when scanning a file in chunks;
// archive entries are scanned as a whole, and the build boundary also rejects
// any secret-like value before it can reach this scanner.
const MAX_MARKER_LENGTH = Math.max(512, ...FORBIDDEN_SECRET_MARKERS.map((marker) => marker.length))
const MAX_ARCHIVE_LIST_BYTES = 4 * 1024 * 1024
const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_EXTRACTED_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 8192
const MAX_NESTED_ARCHIVE_DEPTH = 4

function forbiddenMarkersInText(text) {
  return forbiddenSecretMarkersInText(text)
}

function displayPath(root, path) {
  const value = relative(root, path).split(sep).join('/')
  return value || '.'
}

function isInside(root, path) {
  const prefix = root.endsWith(sep) ? root : root + sep
  return path === root || path.startsWith(prefix)
}

function archivePath(path) {
  return ARCHIVE_EXTENSIONS.has(extname(path).toLowerCase())
}

function unsupportedArchivePath(path) {
  return UNSUPPORTED_ARCHIVE_EXTENSIONS.has(extname(path).toLowerCase())
}

function scanBuffer(display, content) {
  const text = content.toString('latin1')
  return forbiddenMarkersInText(text).map(
    (marker) => `${display}: forbidden secret marker ${marker}`,
  )
}

async function scanFile(root, path) {
  const violations = []
  const seen = new Set()
  let carry = ''
  for await (const chunk of createReadStream(path)) {
    const text = carry + chunk.toString('latin1')
    for (const marker of forbiddenMarkersInText(text)) {
      if (!seen.has(marker) && text.includes(marker)) {
        seen.add(marker)
        violations.push(`${displayPath(root, path)}: forbidden secret marker ${marker}`)
      }
    }
    carry = text.slice(-(MAX_MARKER_LENGTH - 1))
  }
  return violations
}

function containsControlCharacter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function validateArchiveEntry(entry) {
  const normalized = entry.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    segments.some(
      (segment, index) =>
        segment === '..' ||
        segment === '.' ||
        containsControlCharacter(segment) ||
        (segment === '' && index !== segments.length - 1),
    ) ||
    normalized.startsWith('-')
  ) {
    return 'unsafe archive entry path'
  }
  return null
}

function archiveEntries(path) {
  const listing = execFileSync('unzip', ['-Z1', path], {
    encoding: 'utf8',
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entries = listing.split(/\r?\n/).filter(Boolean)
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('archive contains too many entries')
  const details = execFileSync('unzip', ['-Z', '-v', path], {
    encoding: 'utf8',
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const modes = [...details.matchAll(/Unix file attributes \(([0-7]+) octal\):/gi)].map((match) =>
    Number.parseInt(match[1], 8),
  )
  // Without central-directory type metadata a ZIP can hide symlinks, FIFOs or
  // device nodes behind an apparently harmless filename. Fail closed rather
  // than inspecting only the extracted bytes.
  if (modes.length !== entries.length) throw new Error('archive entry metadata is incomplete')
  return entries.map((name, index) => ({ name, mode: modes[index] }))
}

function archiveIsEncrypted(path) {
  const details = execFileSync('unzip', ['-Z', '-v', path], {
    encoding: 'utf8',
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return /file security status:\s*encrypted/i.test(details)
}

async function scanArchive(path, display, depth) {
  const violations = []
  let entries
  try {
    if (archiveIsEncrypted(path)) {
      return [`${display}: encrypted archive cannot be inspected safely`]
    }
    entries = archiveEntries(path)
  } catch {
    return [`${display}: archive could not be inspected safely`]
  }

  let extractedBytes = 0
  const seenEntries = new Set()
  for (const { name: entry, mode } of entries) {
    const normalizedEntry = entry.replaceAll('\\', '/')
    const unsafe = validateArchiveEntry(entry)
    const entryDisplay = `${display}!/${normalizedEntry}`
    if (unsafe) {
      violations.push(`${entryDisplay}: ${unsafe}`)
      continue
    }
    if (seenEntries.has(normalizedEntry)) {
      violations.push(`${entryDisplay}: duplicate archive entry`)
      continue
    }
    seenEntries.add(normalizedEntry)
    const fileType = mode & 0o170000
    const isDirectory = normalizedEntry.endsWith('/')
    if (fileType !== 0 && (isDirectory ? fileType !== 0o040000 : fileType !== 0o100000)) {
      violations.push(`${entryDisplay}: archive entry is not a regular file or directory`)
      continue
    }
    violations.push(...scanBuffer(entryDisplay, Buffer.from(entry, 'utf8')))
    if (entry.endsWith('/')) continue
    if (unsupportedArchivePath(entry)) {
      violations.push(`${entryDisplay}: unsupported archive format`)
      continue
    }

    let content
    try {
      content = execFileSync('unzip', ['-p', path, entry], {
        encoding: 'buffer',
        maxBuffer: MAX_ARCHIVE_ENTRY_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      violations.push(`${entryDisplay}: archive entry is too large or unreadable`)
      continue
    }
    extractedBytes += content.length
    if (extractedBytes > MAX_ARCHIVE_EXTRACTED_BYTES) {
      violations.push(`${display}: archive contents exceed the inspection budget`)
      break
    }
    violations.push(...scanBuffer(entryDisplay, content))

    if (depth < MAX_NESTED_ARCHIVE_DEPTH && archivePath(entry)) {
      const temporaryRoot = mkdtempSync(join(tmpdir(), 'tauri-archive-'))
      const nestedPath = join(temporaryRoot, basename(entry))
      try {
        writeFileSync(nestedPath, content, { mode: 0o600 })
        violations.push(...(await scanArchive(nestedPath, entryDisplay, depth + 1)))
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    } else if (archivePath(entry)) {
      violations.push(`${entryDisplay}: nested archive depth exceeds inspection limit`)
    }
  }
  return violations
}

async function walk(root, path, visited, directDisplayRoot = root) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    const target = await realpath(path)
    if (!isInside(root, target)) {
      return [`${displayPath(root, path)}: symbolic link resolves outside artifact root`]
    }
    if (visited.has(target)) return []
    visited.add(target)
    return walk(root, target, visited, directDisplayRoot)
  }
  if (info.isDirectory()) {
    const violations = []
    for (const entry of await readdir(path)) {
      violations.push(...(await walk(root, resolve(path, entry), visited, directDisplayRoot)))
    }
    return violations
  }
  if (info.isFile()) {
    const display = path === root ? displayPath(directDisplayRoot, path) : displayPath(root, path)
    if (unsupportedArchivePath(path)) {
      return [`${display}: unsupported archive format`]
    }
    if (archivePath(path)) {
      return scanArchive(path, display, 0)
    }
    return scanFile(root, path)
  }
  return [`${displayPath(root, path)}: unsupported artifact filesystem entry`]
}

export async function scanTauriArtifacts(paths, cwd = process.cwd()) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('usage: check-tauri-artifact.mjs <artifact-file-or-directory> [...]')
  }
  const roots = paths.map((path) => resolve(cwd, path))
  const violations = []
  for (const root of roots) {
    try {
      violations.push(...(await walk(root, root, new Set([root]), cwd)))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        violations.push(`${displayPath(cwd, root)}: artifact path does not exist`)
      } else throw error
    }
  }
  return violations.sort()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await scanTauriArtifacts(process.argv.slice(2))
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation)
    process.exitCode = 1
  } else {
    console.log('Tauri artifact secret scan: ok')
  }
}
