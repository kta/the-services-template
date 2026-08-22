#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const IDENTIFIER = '(?:UC|AC)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+'
const identifierPattern = new RegExp(`\\b${IDENTIFIER}\\b`, 'g')
const mappingPattern = new RegExp(
  `^[\\t ]*//\\s*@e2e-covers\\s+((?:${IDENTIFIER})(?:\\s+(?:${IDENTIFIER}))*)\\s*$`,
  'gm',
)
const testDeclaration = /^\s*test(?:\.(?:only|skip|fixme))?\s*\(/u

async function filesUnder(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    }),
  )
  return files.flat()
}

function isApprovedSpecification(source) {
  return /(?:ステータス|Status)\s*:\s*Approved(?:\s|$|[（(])/mu.test(source)
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

async function approvedIdentifiers(root) {
  const specsRoot = resolve(root, 'specs')
  const files = (await filesUnder(specsRoot)).filter((path) => path.endsWith('/spec.md')).sort()
  const identifiers = new Set()

  for (const path of files) {
    const source = await readFile(path, 'utf8')
    if (!isApprovedSpecification(source)) continue
    for (const match of source.matchAll(identifierPattern)) identifiers.add(match[0])
  }
  return identifiers
}

async function e2eMappings(root) {
  const servicesRoot = resolve(root, 'services')
  const files = (await filesUnder(servicesRoot))
    .filter((path) => /\/e2e\/.*\.spec\.(?:[cm]?js|tsx?)$/u.test(path))
    .sort()
  const mappings = []
  const invalidMappings = []

  for (const path of files) {
    const source = await readFile(path, 'utf8')
    const displayPath = relative(root, path)
    for (const match of source.matchAll(mappingPattern)) {
      const line = lineAt(source, match.index)
      const identifiers = match[1].split(/\s+/u)
      const followsTest = testDeclaration.test(source.slice(match.index + match[0].length))
      for (const id of identifiers) {
        const mapping = { id, path: displayPath, line }
        if (followsTest) mappings.push(mapping)
        else invalidMappings.push(mapping)
      }
    }
  }
  return { mappings, invalidMappings }
}

/**
 * Validate one-to-one coverage between every UC/AC in an Approved feature spec
 * and an immediately following Playwright test carrying `@e2e-covers`.
 *
 * @param {string} root repository root
 * @returns {Promise<string[]>} deterministic diagnostics; an empty list is valid
 */
export async function validateTraceability(root) {
  const approved = await approvedIdentifiers(root)
  const { mappings, invalidMappings } = await e2eMappings(root)
  const errors = []

  for (const mapping of [...mappings, ...invalidMappings]) {
    if (!approved.has(mapping.id)) {
      errors.push(`Unknown E2E mapping ${mapping.id} in ${mapping.path}.`)
    }
  }
  for (const mapping of invalidMappings) {
    errors.push(
      `E2E mapping ${mapping.id} in ${mapping.path}:${mapping.line} does not target a Playwright test.`,
    )
  }

  for (const id of [...approved].sort()) {
    const mapped = mappings.filter((mapping) => mapping.id === id)
    if (mapped.length === 0) {
      errors.push(`Missing E2E mapping for approved ${id}.`)
    } else if (mapped.length > 1) {
      errors.push(
        `Duplicate E2E mapping for ${id}: ${mapped
          .map((mapping) => `${mapping.path}:${mapping.line}`)
          .join(', ')}.`,
      )
    }
  }

  return errors
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const errors = await validateTraceability(root)
  if (errors.length === 0) {
    console.log('E2E traceability: all approved UC/AC identifiers are mapped exactly once.')
    return
  }
  for (const error of errors) console.error(error)
  process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
