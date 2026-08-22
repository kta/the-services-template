#!/usr/bin/env node

import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeFlags, SyntaxKind } from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'

const IDENTIFIER = '(?:UC|AC)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+'
const definitionPattern = new RegExp(`^[\\t ]*-\\s+(${IDENTIFIER}):\\s+\\S.*$`, 'gm')
const mappingPattern = new RegExp(
  `^[\\t ]*//\\s*@e2e-covers\\s+((?:${IDENTIFIER})(?:\\s+(?:${IDENTIFIER}))*)\\s*$`,
  'gm',
)
const statusPattern = /^[\t ]*-\s+(?:ステータス|Status):\s*(Draft|Approved)\s*$/mu

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

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function isInside(root, path) {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function isPlaywrightTestImport(statement) {
  return (
    statement.kind === SyntaxKind.ImportDeclaration &&
    statement.moduleSpecifier?.kind === SyntaxKind.StringLiteral &&
    statement.moduleSpecifier.text === '@playwright/test'
  )
}

function addBinding(bindings, name, start) {
  const positions = bindings.get(name) ?? new Set()
  positions.add(start)
  bindings.set(name, positions)
}

function addBindingNames(name, bindings) {
  if (name.kind === SyntaxKind.Identifier) {
    addBinding(bindings, name.text, name.getStart())
    return
  }
  for (const element of name.elements) {
    if (element.kind === SyntaxKind.BindingElement) addBindingNames(element.name, bindings)
  }
}

function addModuleScopedVarBindings(node, bindings) {
  if (
    node.kind === SyntaxKind.FunctionDeclaration ||
    node.kind === SyntaxKind.FunctionExpression ||
    node.kind === SyntaxKind.ArrowFunction ||
    node.kind === SyntaxKind.ClassDeclaration ||
    node.kind === SyntaxKind.ClassExpression ||
    node.kind === SyntaxKind.ModuleDeclaration
  )
    return
  if (node.kind === SyntaxKind.VariableDeclarationList && node.flags === NodeFlags.None) {
    for (const declaration of node.declarations) addBindingNames(declaration.name, bindings)
  }
  node.forEachChild((child) => addModuleScopedVarBindings(child, bindings))
}

function topLevelValueBindings(file) {
  const bindings = new Map()
  for (const statement of file.statements) {
    if (statement.kind === SyntaxKind.ImportDeclaration) {
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      if (clause.name) addBinding(bindings, clause.name.text, clause.name.getStart(file))
      const named = clause.namedBindings
      if (!named) continue
      if (named.kind === SyntaxKind.NamespaceImport) {
        addBinding(bindings, named.name.text, named.name.getStart(file))
      } else if (named.kind === SyntaxKind.NamedImports) {
        for (const element of named.elements) {
          if (!element.isTypeOnly)
            addBinding(bindings, element.name.text, element.name.getStart(file))
        }
      }
      continue
    }
    if (statement.kind === SyntaxKind.VariableStatement) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, bindings)
      }
      continue
    }
    if (
      (statement.kind === SyntaxKind.FunctionDeclaration ||
        statement.kind === SyntaxKind.ClassDeclaration ||
        statement.kind === SyntaxKind.EnumDeclaration) &&
      statement.name
    ) {
      addBinding(bindings, statement.name.text, statement.name.getStart(file))
    }
  }
  // `var` in a source-file block is hoisted into module scope, unlike a
  // block-scoped `let`/`const`. Walk non-function descendants to retain that
  // distinction without treating a nested function parameter as a shadow.
  addModuleScopedVarBindings(file, bindings)
  return bindings
}

function topLevelPlaywrightTestCalls(file) {
  const importedTestBindings = new Map()
  for (const statement of file.statements) {
    if (!isPlaywrightTestImport(statement) || !statement.importClause?.namedBindings) continue
    const { importClause } = statement
    if (importClause.isTypeOnly || importClause.namedBindings.kind !== SyntaxKind.NamedImports)
      continue
    for (const element of importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (importedName === 'test' && !element.isTypeOnly) {
        importedTestBindings.set(element.name.text, element.name.getStart(file))
      }
    }
  }

  const sourceScopeBindings = topLevelValueBindings(file)
  const calls = []
  for (const statement of file.statements) {
    // The convention intentionally permits only a direct source-file statement.
    // A test nested in a function or describe callback is not a guaranteed
    // Playwright registration, even if its identifier spells `test`.
    if (statement.kind !== SyntaxKind.ExpressionStatement) continue
    const call = statement.expression
    if (call.kind !== SyntaxKind.CallExpression) continue
    const callee = call.expression
    let binding
    let modifier
    if (callee.kind === SyntaxKind.Identifier) {
      binding = callee.text
    } else if (
      callee.kind === SyntaxKind.PropertyAccessExpression &&
      callee.expression.kind === SyntaxKind.Identifier &&
      ['only', 'skip', 'fixme'].includes(callee.name.text)
    ) {
      binding = callee.expression.text
      modifier = callee.name.text
    }
    if (!binding || !importedTestBindings.has(binding)) continue
    // A value declared in source-file scope with the same name wins over the
    // import. Nested declarations do not shadow this direct source-file call.
    const sourceBindings = sourceScopeBindings.get(binding)
    if (sourceBindings?.size !== 1 || !sourceBindings.has(importedTestBindings.get(binding)))
      continue
    calls.push({ binding, modifier, start: call.getStart(file) })
  }
  return calls
}

async function playwrightTestCalls(path) {
  const api = new API()
  let snapshot
  try {
    snapshot = api.updateSnapshot({ openFiles: [path] })
    const project = snapshot.getDefaultProjectForFile(path)
    const file = project?.program.getSourceFile(path)
    if (!file) throw new Error(`TypeScript could not parse E2E file ${path}.`)
    return topLevelPlaywrightTestCalls(file)
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

async function regularFiles(candidates, root, kind) {
  if (candidates.length === 0) return { files: [], errors: [] }
  const realRoot = await realpath(root)
  const files = []
  const errors = []

  for (const path of candidates) {
    const displayPath = relative(root, path)
    const details = await lstat(path)
    if (!details.isFile()) {
      errors.push(`Refusing non-regular ${kind} file ${displayPath}.`)
      continue
    }
    const resolvedPath = await realpath(path)
    if (!isInside(realRoot, resolvedPath)) {
      errors.push(`Refusing ${kind} file outside its root ${displayPath}.`)
      continue
    }
    files.push(path)
  }
  return { files, errors }
}

async function specificationIdentifiers(root) {
  const specsRoot = resolve(root, 'specs')
  const candidates = (await filesUnder(specsRoot))
    .filter((path) => path.endsWith('/spec.md'))
    .sort()
  const { files, errors } = await regularFiles(candidates, root, 'specification')
  const approved = new Set()
  const definitions = new Map()

  for (const path of files) {
    const source = await readFile(path, 'utf8')
    const displayPath = relative(root, path)
    const status = source.match(statusPattern)?.[1]
    if (!status) {
      errors.push(
        `Feature spec ${displayPath} must declare \`- ステータス: Draft\` or \`- ステータス: Approved\`.`,
      )
      continue
    }
    for (const match of source.matchAll(definitionPattern)) {
      const id = match[1]
      const existing = definitions.get(id) ?? []
      definitions.set(id, [...existing, displayPath])
      if (status === 'Approved') approved.add(id)
    }
  }
  for (const [id, paths] of [...definitions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (paths.length > 1) {
      errors.push(`Duplicate specification identifier ${id}: ${paths.sort().join(', ')}.`)
    }
  }
  return { approved, errors }
}

async function e2eMappings(root) {
  const servicesRoot = resolve(root, 'services')
  const candidates = (await filesUnder(servicesRoot))
    .filter((path) => /\/e2e\/.*\.spec\.(?:[cm]?js|tsx?)$/u.test(path))
    .sort()
  const { files, errors } = await regularFiles(candidates, root, 'E2E')
  const mappings = []
  const invalidMappings = []
  const disabledMappings = []

  for (const path of files) {
    const source = await readFile(path, 'utf8')
    const displayPath = relative(root, path)
    const testCalls = await playwrightTestCalls(path)
    for (const match of source.matchAll(mappingPattern)) {
      const line = lineAt(source, match.index)
      const identifiers = match[1].split(/\s+/u)
      const testTarget = testCalls.find(
        (call) => source.slice(match.index + match[0].length, call.start).trim() === '',
      )
      for (const id of identifiers) {
        const mapping = { id, path: displayPath, line }
        if (!testTarget) invalidMappings.push(mapping)
        else if (testTarget.modifier)
          disabledMappings.push({ ...mapping, modifier: testTarget.modifier })
        else mappings.push(mapping)
      }
    }
  }
  return { mappings, invalidMappings, disabledMappings, errors }
}

/**
 * Validate one-to-one coverage between every UC/AC in an Approved feature spec
 * and an immediately following Playwright test carrying `@e2e-covers`.
 *
 * @param {string} root repository root
 * @returns {Promise<string[]>} deterministic diagnostics; an empty list is valid
 */
export async function validateTraceability(root) {
  const { approved, errors: specificationErrors } = await specificationIdentifiers(root)
  const { mappings, invalidMappings, disabledMappings, errors: e2eErrors } = await e2eMappings(root)
  const errors = [...specificationErrors, ...e2eErrors]

  for (const mapping of [...mappings, ...invalidMappings, ...disabledMappings]) {
    if (!approved.has(mapping.id)) {
      errors.push(`Unknown E2E mapping ${mapping.id} in ${mapping.path}.`)
    }
  }
  for (const mapping of invalidMappings) {
    errors.push(
      `E2E mapping ${mapping.id} in ${mapping.path}:${mapping.line} does not target a Playwright test.`,
    )
  }
  for (const mapping of disabledMappings) {
    errors.push(
      `E2E mapping ${mapping.id} in ${mapping.path}:${mapping.line} targets test.${mapping.modifier}, which cannot satisfy traceability.`,
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
