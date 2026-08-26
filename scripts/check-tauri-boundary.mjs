#!/usr/bin/env node

import { lstat, readdir, readFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript/unstable/ast'
import { API as TypeScriptAPI } from 'typescript/unstable/sync'

const WEB_DIRECTORY = 'services/admin/src/web'
const TAURI_DIRECTORY = 'services/admin/src-tauri'
const TAURI_CONFIG = 'services/admin/src-tauri/tauri.conf.json'
const CAPABILITIES_DIRECTORY = 'services/admin/src-tauri/capabilities'
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const FORBIDDEN_WEB_PLUGINS = [
  '@tauri-apps/plugin-http',
  '@tauri-apps/plugin-store',
  '@tauri-apps/plugin-stronghold',
]
const SECRET_NAMES = ['JWT_SECRET', 'AUTH_PEPPER', 'INTERNAL_KEY', 'RESEND']
const STORAGE_ALLOWLIST = new Map([
  [
    'services/admin/src/web/auth/session.ts',
    {
      key: 'app.admin.dev.token',
      reason: 'development-only fallback token; native sessions never use browser storage',
    },
  ],
])

async function filesUnder(directory, includeSymlinks = false) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      if (includeSymlinks) files.push(resolve(directory, entry.name))
      continue
    }
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(path, includeSymlinks)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function relativePath(root, path) {
  return relative(root, path).split('/').join('/')
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function isTestSource(path) {
  return /(?:^|[\\/])(?:__tests__|test)(?:[\\/]|$)|(?:^|[\\.])(?:test|spec)\.[^.]+$/i.test(path)
}

function isProductionWebSource(path) {
  return SOURCE_EXTENSIONS.has(extname(path)) && !isTestSource(path)
}

function isTransportSource(root, path) {
  return relativePath(root, path) === `${WEB_DIRECTORY}/platform/transport.ts`
}

function unwrapExpression(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertion(node) ||
      ts.isNonNullExpression(node))
  )
    node = node.expression
  return node
}

function stringValue(node) {
  if (node && ts.isStringLiteral(node)) return node.text
  if (node && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringValue(node.left)
    const right = stringValue(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return stringValue(node.argumentExpression)
  return undefined
}

function collectBoundaryAliases(sourceFile) {
  const globals = new Set(['globalThis', 'window'])
  const fetches = new Set(['fetch'])
  const fetchRisks = new Set()
  const storages = new Set(['localStorage', 'sessionStorage'])
  const storageMethods = new Set()
  const storagePrototypes = new Set()
  const reflectApplies = new Set()
  const declarations = []

  function addBinding(name, initializer) {
    if (!ts.isIdentifier(name)) return
    declarations.push([name.text, initializer])
  }
  function collectBinding(pattern, initializer) {
    if (ts.isIdentifier(pattern)) {
      addBinding(pattern, initializer)
      return
    }
    if (!initializer) return
    if (ts.isObjectBindingPattern(pattern))
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue
        const key = element.propertyName ?? element.name
        const keyName = ts.isIdentifier(key) ? key.text : stringValue(key)
        if (
          keyName === 'fetch' ||
          keyName === 'sessionStorage' ||
          keyName === 'localStorage' ||
          keyName === 'setItem'
        )
          addBinding(element.name, { kind: 'boundary-property', base: initializer, key: keyName })
      }
    if (ts.isObjectLiteralExpression(pattern)) {
      for (const property of pattern.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.initializer)) continue
        const keyName = ts.isIdentifier(property.name)
          ? property.name.text
          : stringValue(property.name)
        if (['fetch', 'sessionStorage', 'localStorage', 'setItem'].includes(keyName))
          addBinding(property.initializer, {
            kind: 'boundary-property',
            base: initializer,
            key: keyName,
          })
      }
    }
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node)) collectBinding(node.name, node.initializer)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      collectBinding(unwrapExpression(node.left), node.right)
    node.forEachChild(visit)
  }
  visit(sourceFile)

  function shape(expression) {
    expression = unwrapExpression(expression)
    if (!expression) return ''
    if (ts.isIdentifier(expression)) {
      if (globals.has(expression.text)) return 'global'
      if (fetches.has(expression.text)) return 'fetch'
      if (fetchRisks.has(expression.text)) return 'fetch-risk'
      if (storages.has(expression.text)) return 'storage'
      if (storageMethods.has(expression.text)) return 'storage-method'
      if (storagePrototypes.has(expression.text)) return 'storage-prototype'
      if (reflectApplies.has(expression.text)) return 'reflect-apply'
      if (expression.text === 'Storage') return 'storage-constructor'
      if (expression.text === 'Reflect') return 'reflect'
      return ''
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = shape(expression.expression)
      const name = propertyName(expression)
      if (base === 'global' && name === 'fetch') return 'fetch'
      if (base === 'global' && name === undefined) return 'fetch-risk'
      if (base === 'global' && (name === 'sessionStorage' || name === 'localStorage'))
        return 'storage'
      if (base === 'storage' && name === 'setItem') return 'storage-method'
      if (base === 'storage') return 'storage'
      if (base === 'storage-constructor' && name === 'prototype') return 'storage-prototype'
      if (base === 'storage-prototype' && name === 'setItem') return 'storage-method'
      if (base === 'storage-method' && name === 'call') return 'storage-method-call'
      if (base === 'storage-method' && name === 'bind') return 'storage-method-bind'
      if (base === 'reflect' && name === 'apply') return 'reflect-apply'
      if (base === 'reflect-apply' && name === 'bind') return 'reflect-apply-bind'
      if (base === 'fetch' && name === 'bind') return 'fetch-bind'
      if (base === 'fetch' && name === 'call') return 'fetch'
      return ''
    }
    if (ts.isCallExpression(expression)) {
      const callee = shape(expression.expression)
      if (callee === 'storage-method-call') return 'storage-write'
      if (callee === 'storage-method-bind') return 'storage-method'
      if (callee === 'reflect-apply-bind') return 'reflect-apply'
      if (callee === 'fetch-bind') return 'fetch'
      if (
        ts.isPropertyAccessExpression(expression.expression) &&
        propertyName(expression.expression) === 'apply' &&
        shape(expression.expression.expression) === 'Reflect'
      )
        return 'reflect-apply'
    }
    return ''
  }

  // Resolve aliases to a fixed point. Unknown or shadowed identifiers remain
  // violations when they retain a boundary-sensitive spelling.
  let changed = true
  while (changed) {
    changed = false
    for (const [name, initializer] of declarations) {
      const base = initializer?.kind === 'boundary-property' ? shape(initializer.base) : ''
      const value =
        initializer?.kind === 'boundary-property'
          ? base === 'global' && initializer.key === 'fetch'
            ? 'fetch'
            : base === 'global' &&
                (initializer.key === 'sessionStorage' || initializer.key === 'localStorage')
              ? 'storage'
              : (base === 'storage' || base === 'storage-prototype') &&
                  initializer.key === 'setItem'
                ? 'storage-method'
                : ''
          : shape(initializer)
      const set =
        value === 'fetch'
          ? fetches
          : value === 'fetch-risk'
            ? fetchRisks
            : value === 'storage'
              ? storages
              : value === 'storage-method'
                ? storageMethods
                : value === 'storage-prototype'
                  ? storagePrototypes
                  : value === 'reflect-apply'
                    ? reflectApplies
                    : value === 'global'
                      ? globals
                      : null
      if (set && !set.has(name)) {
        set.add(name)
        changed = true
      }
      if (value === 'fetch' && !fetches.has(name)) {
        fetches.add(name)
        changed = true
      }
      if (value === 'storage-method' && !storageMethods.has(name)) {
        storageMethods.add(name)
        changed = true
      }
    }
  }
  return { globals, fetches, storages, storageMethods, shape }
}

function pushMatchViolations(violations, root, path, source, pattern, message) {
  for (const match of source.matchAll(pattern)) {
    violations.push(`${relativePath(root, path)}:${lineAt(source, match.index)}: ${message}`)
  }
}

/* Legacy lexer retained below temporarily during the AST migration. */
function _tokenize(source) {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const start = index
    const char = source[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2)
      if (index < 0) break
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      index += 1
      let value = ''
      while (index < source.length) {
        if (source[index] === '\\') {
          const escaped = source[index + 1]
          value += escaped === undefined ? '' : escaped
          index += 2
        } else if (source[index] === quote) {
          index += 1
          break
        } else {
          value += source[index]
          index += 1
        }
      }
      tokens.push({ kind: 'string', value, start, end: index })
      continue
    }
    if (char === '`') {
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') index += 2
        else if (source[index++] === '`') break
      }
      tokens.push({
        kind: 'template',
        value: source.slice(start + 1, index - 1),
        start,
        end: index,
      })
      continue
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0]
    if (identifier) {
      index += identifier.length
      tokens.push({ kind: 'identifier', value: identifier, start, end: index })
      continue
    }
    const punctuation = source
      .slice(index)
      .match(/^(?:\?\.|=>|===|!==|==|!=|&&|\|\||\+=|-=|\*\*|\.{3})/)?.[0]
    if (punctuation) {
      index += punctuation.length
      tokens.push({ kind: 'punctuation', value: punctuation, start, end: index })
      continue
    }
    index += 1
    tokens.push({ kind: 'punctuation', value: char, start, end: index })
  }
  return tokens
}

function tokenValue(token) {
  return token?.value
}

function isIdentifier(token, value) {
  return token?.kind === 'identifier' && (value === undefined || token.value === value)
}

function isString(token, value) {
  return token?.kind === 'string' && (value === undefined || token.value === value)
}

function isPunctuation(token, value) {
  return token?.kind === 'punctuation' && token.value === value
}

function matchingToken(tokens, index, open, close) {
  if (!isPunctuation(tokens[index], open)) return -1
  let depth = 0
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    if (isPunctuation(tokens[cursor], open)) depth += 1
    else if (isPunctuation(tokens[cursor], close) && --depth === 0) return cursor
  }
  return -1
}

function memberReference(tokens, index, objectNames, property) {
  if (!isIdentifier(tokens[index], objectNames) && !objectNames.has(tokenValue(tokens[index]))) {
    return false
  }
  if (isPunctuation(tokens[index + 1], '.') || isPunctuation(tokens[index + 1], '?.')) {
    return isIdentifier(tokens[index + 2], property)
  }
  return (
    isPunctuation(tokens[index + 1], '[') &&
    isString(tokens[index + 2], property) &&
    isPunctuation(tokens[index + 3], ']')
  )
}

function directReference(tokens, index, names, property) {
  if (typeof names === 'string' && isIdentifier(tokens[index], names)) return true
  if (names instanceof Set && names.has(tokenValue(tokens[index]))) return true
  return memberReference(tokens, index, names, property)
}

function _collectAliases(tokens, objectNames, property) {
  const aliases = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < tokens.length; index += 1) {
      if (!['const', 'let', 'var'].includes(tokenValue(tokens[index]))) continue
      const alias = tokens[index + 1]
      if (!isIdentifier(alias) || !isPunctuation(tokens[index + 2], '=')) continue
      const target = tokens[index + 3]
      if (
        directReference(tokens, index + 3, objectNames, property) ||
        aliases.has(tokenValue(target))
      ) {
        if (!aliases.has(alias.value)) {
          aliases.add(alias.value)
          changed = true
        }
      }
    }
    for (let index = 0; index + 7 < tokens.length; index += 1) {
      // const { fetch: alias } = globalThis/window
      if (
        !['const', 'let', 'var'].includes(tokenValue(tokens[index])) ||
        !isPunctuation(tokens[index + 1], '{') ||
        !isIdentifier(tokens[index + 2], property) ||
        !isPunctuation(tokens[index + 3], ':') ||
        !isIdentifier(tokens[index + 4], undefined) ||
        !isPunctuation(tokens[index + 5], '}') ||
        !isPunctuation(tokens[index + 6], '=') ||
        !isIdentifier(tokens[index + 7], undefined) ||
        !objectNames.has(tokens[index + 7].value)
      )
        continue
      if (!aliases.has(tokens[index + 4].value)) {
        aliases.add(tokens[index + 4].value)
        changed = true
      }
    }
  }
  return aliases
}

function fetchBoundaryReferences(sourceFile) {
  const aliases = collectBoundaryAliases(sourceFile)
  const references = []
  function visit(node) {
    const directGlobalComputedFetch =
      ts.isCallExpression(node) &&
      ts.isElementAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === 'globalThis' ||
        node.expression.expression.text === 'window')
    if (
      ts.isCallExpression(node) &&
      (['fetch', 'fetch-risk'].includes(aliases.shape(node.expression)) ||
        (ts.isElementAccessExpression(node.expression) &&
          aliases.shape(node.expression.expression) === 'global'))
    )
      references.push(node)
    else if (directGlobalComputedFetch) references.push(node)
    if (
      ts.isIdentifier(node) &&
      node.text === 'fetch' &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    )
      references.push(node)
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return references
}

function checkWebSource(violations, root, path, source, sourceFile, checker) {
  for (const plugin of FORBIDDEN_WEB_PLUGINS) {
    const escaped = plugin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const importPattern = new RegExp(
      `(?:\\bimport\\s*(?:\\(\\s*)?|\\bfrom\\s+|\\brequire\\s*\\(\\s*)['"]${escaped}['"]`,
      'g',
    )
    pushMatchViolations(
      violations,
      root,
      path,
      source,
      importPattern,
      `forbidden Tauri plugin import: ${plugin}`,
    )
  }

  if (!isTransportSource(root, path)) {
    // A dynamic property read from the global object may resolve to fetch;
    // there is no safe static proof for a user-controlled key, so fail closed.
    if (/\b(?:globalThis|window)\s*\[/.test(source)) {
      violations.push(
        `${relativePath(root, path)}:1: raw fetch is only allowed in the platform transport source`,
      )
    }
    for (const reference of fetchBoundaryReferences(sourceFile)) {
      violations.push(
        `${relativePath(root, path)}:${lineAt(source, reference.start)}: raw fetch is only allowed in the platform transport source`,
      )
    }
  }

  checkStorageWrites(violations, root, path, source, sourceFile, checker)
}

function _tokenText(source, tokens, start, end) {
  if (start < 0 || end < start || !tokens[start] || !tokens[end]) return ''
  return source.slice(tokens[start].start, tokens[end].end)
}

function _storageReferences(tokens) {
  const names = new Set(['localStorage', 'sessionStorage'])
  const browserStorage = new Set(['globalThis', 'window'])
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index + 3 < tokens.length; index += 1) {
      if (!['const', 'let', 'var'].includes(tokenValue(tokens[index]))) continue
      const alias = tokens[index + 1]
      if (!isIdentifier(alias) || !isPunctuation(tokens[index + 2], '=')) continue
      if (
        directReference(tokens, index + 3, names, 'sessionStorage') ||
        memberReference(tokens, index + 3, browserStorage, 'sessionStorage') ||
        names.has(tokenValue(tokens[index + 3]))
      ) {
        if (!names.has(alias.value)) {
          names.add(alias.value)
          changed = true
        }
      }
    }
    for (let index = 0; index + 7 < tokens.length; index += 1) {
      if (
        !['const', 'let', 'var'].includes(tokenValue(tokens[index])) ||
        !isPunctuation(tokens[index + 1], '{') ||
        !isIdentifier(tokens[index + 2], 'sessionStorage') ||
        !isPunctuation(tokens[index + 3], ':') ||
        !isIdentifier(tokens[index + 4]) ||
        !isPunctuation(tokens[index + 5], '}') ||
        !isPunctuation(tokens[index + 6], '=') ||
        !['globalThis', 'window'].includes(tokenValue(tokens[index + 7]))
      )
        continue
      if (!names.has(tokens[index + 4].value)) {
        names.add(tokens[index + 4].value)
        changed = true
      }
    }
  }
  return names
}

function storageWrites(sourceFile) {
  const aliases = collectBoundaryAliases(sourceFile)
  const writes = []
  const add = (node, keyNode, valueNode, shape) => {
    if (!keyNode || !valueNode) return
    writes.push({
      node,
      index: node.getStart(sourceFile),
      keyNode,
      valueNode,
      keyArgument: keyNode.getText(sourceFile).trim(),
      valueArgument: valueNode.getText(sourceFile).trim(),
      shape,
    })
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const calleeShape = aliases.shape(callee)
      if (calleeShape === 'storage-method' || calleeShape === 'storage') {
        const receiver =
          ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? callee.expression
            : undefined
        const exact =
          ts.isPropertyAccessExpression(callee) &&
          !callee.questionDotToken &&
          ts.isIdentifier(receiver) &&
          receiver.text === 'sessionStorage'
        add(
          node,
          node.arguments[0],
          node.arguments[1],
          exact ? 'sessionStorage.setItem' : 'indirect storage write',
        )
      } else if (calleeShape === 'storage-method-call') {
        add(node, node.arguments[1], node.arguments[2], 'Storage.prototype.setItem')
      } else if (
        aliases.shape(callee) === 'reflect-apply' ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'apply' &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'Reflect')
      ) {
        const method = node.arguments[0]
        if (aliases.shape(method) === 'storage-method') {
          const args = node.arguments[2]
          const key = ts.isArrayLiteralExpression(args) ? args.elements[0] : undefined
          const value = ts.isArrayLiteralExpression(args) ? args.elements[1] : undefined
          add(node, key, value, 'Reflect.apply')
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      aliases.shape(node.left.expression) === 'storage'
    )
      add(node, node.left.argumentExpression, node.right, 'storage property assignment')
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return { writes }
}

function _legacyFindDevLoginBody(tokens) {
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if (!isIdentifier(tokens[index], 'devLogin')) continue
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (isPunctuation(tokens[cursor], '{')) {
        const close = matchingToken(tokens, cursor, '{', '}')
        if (close >= 0) return { start: cursor + 1, end: close }
        break
      }
      if (isPunctuation(tokens[cursor], ';')) break
    }
  }
  return null
}

function _legacyIsDocumentedDevFallback(pathName, tokens, write) {
  const allow = STORAGE_ALLOWLIST.get(pathName)
  if (!allow || write.shape !== 'sessionStorage.setItem') return false
  if (write.keyArgument !== 'DEV_TOKEN_KEY' || write.valueArgument !== 'token') return false
  const keyDeclaration = tokens.filter(
    (token, index) =>
      isIdentifier(token, 'DEV_TOKEN_KEY') &&
      isIdentifier(tokens[index - 1], 'const') &&
      isPunctuation(tokens[index + 1], '=') &&
      isString(tokens[index + 2], allow.key),
  )
  if (keyDeclaration.length !== 1) return false
  const body = findDevLoginBody(tokens)
  if (!body) return false
  const writeToken = tokens.findIndex((token) => token.start === write.index)
  if (writeToken < body.start || writeToken >= body.end) return false

  // The only accepted value is a token destructured directly from the
  // /api/auth/token response in this devLogin body. No inferred taint graph is
  // needed: all other shapes fail closed.
  let responseToken = -1
  let responseVariable = ''
  for (let index = body.start; index + 8 < body.end; index += 1) {
    if (
      !['const', 'let', 'var'].includes(tokenValue(tokens[index])) ||
      !isIdentifier(tokens[index + 1]) ||
      !isPunctuation(tokens[index + 2], '=') ||
      !isIdentifier(tokens[index + 3], 'await') ||
      !isIdentifier(tokens[index + 4], 'platformFetch') ||
      !isPunctuation(tokens[index + 5], '(') ||
      !isString(tokens[index + 6], '/api/auth/token')
    )
      continue
    responseVariable = tokens[index + 1].value
    break
  }
  if (!responseVariable) return false
  for (let index = body.start; index + 8 < body.end; index += 1) {
    if (
      !['const', 'let', 'var'].includes(tokenValue(tokens[index])) ||
      !isPunctuation(tokens[index + 1], '{') ||
      !isIdentifier(tokens[index + 2], 'token') ||
      !isPunctuation(tokens[index + 3], '}') ||
      !isPunctuation(tokens[index + 4], '=')
    )
      continue
    let cursor = index + 5
    if (isPunctuation(tokens[cursor], '(')) cursor += 1
    if (
      !isIdentifier(tokens[cursor], 'await') ||
      !isIdentifier(tokens[cursor + 1], responseVariable) ||
      !(isPunctuation(tokens[cursor + 2], '.') || isPunctuation(tokens[cursor + 2], '?.')) ||
      !isIdentifier(tokens[cursor + 3], 'json') ||
      !isPunctuation(tokens[cursor + 4], '(')
    )
      continue
    responseToken = index + 2
    break
  }
  if (responseToken < 0 || responseToken >= writeToken) return false
  for (let index = responseToken + 1; index < writeToken; index += 1) {
    if (
      isIdentifier(tokens[index], 'token') &&
      (isPunctuation(tokens[index + 1], '=') || isPunctuation(tokens[index - 1], 'const'))
    )
      return false
  }
  return true
}

function isWithin(node, container) {
  return node.getStart() >= container.getStart() && node.end <= container.end
}

function findDevLoginBodyAst(sourceFile) {
  let found
  function visit(node) {
    if (found) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'devLogin') found = node.body
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return found
}

function platformFetchImportSymbol(sourceFile, checker) {
  let symbol
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    if (!statement.moduleSpecifier.text.endsWith('/platform/transport')) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) !== 'platformFetch') continue
      symbol = checker?.getSymbolAtLocation(element.name)
    }
  }
  return symbol
}

function tokenBindings(sourceFile) {
  const bindings = []
  function scopeFor(node) {
    let current = node.parent
    while (current && !ts.isBlock(current) && !ts.isSourceFile(current)) current = current.parent
    return current ?? node.parent
  }
  function add(name, scope) {
    if (ts.isIdentifier(name) && name.text === 'token') bindings.push({ name, scope })
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name
          if (ts.isIdentifier(key) && key.text === 'token') add(element.name, scopeFor(node))
        }
      } else add(node.name, scopeFor(node))
    }
    if (ts.isIdentifier(node) && node.parent && ts.isParameterDeclaration(node.parent))
      add(node, scopeFor(node.parent))
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return bindings
}

function resolveTokenBinding(identifier, bindings, checker) {
  const symbol = checker?.getSymbolAtLocation(identifier)
  return bindings
    .filter(
      ({ name, scope }) =>
        name.text === identifier.text &&
        name.getStart() <= identifier.getStart() &&
        isWithin(identifier, scope) &&
        (!symbol || checker.getSymbolAtLocation(name)?.id === symbol.id),
    )
    .sort((a, b) => b.name.getStart() - a.name.getStart())[0]
}

function isDocumentedDevFallbackAst(pathName, sourceFile, write, checker) {
  const allow = STORAGE_ALLOWLIST.get(pathName)
  if (!allow || write.shape !== 'sessionStorage.setItem') return false
  if (
    write.keyArgument !== 'DEV_TOKEN_KEY' ||
    !ts.isIdentifier(write.valueNode) ||
    write.valueArgument !== 'token'
  )
    return false
  const body = findDevLoginBodyAst(sourceFile)
  const platformFetchSymbol = platformFetchImportSymbol(sourceFile, checker)
  if (!body || !platformFetchSymbol || !isWithin(write.node, body)) return false
  let keyDeclarations = 0
  let responseSymbol
  let responseToken
  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      if (
        ts.isIdentifier(node.name) &&
        node.name.text === 'DEV_TOKEN_KEY' &&
        stringValue(node.initializer) === allow.key
      )
        keyDeclarations += 1
      const initializer = unwrapExpression(node.initializer)
      if (
        isWithin(node, body) &&
        ts.isIdentifier(node.name) &&
        ts.isAwaitExpression(initializer) &&
        ts.isCallExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        checker?.getSymbolAtLocation(initializer.expression.expression)?.id ===
          platformFetchSymbol.id &&
        stringValue(initializer.expression.arguments[0]) === '/api/auth/token'
      ) {
        const symbol = checker?.getSymbolAtLocation(node.name)
        if (!symbol) return
        responseSymbol = symbol
      }
      if (
        isWithin(node, body) &&
        ts.isObjectBindingPattern(node.name) &&
        ts.isAwaitExpression(initializer) &&
        ts.isCallExpression(initializer.expression)
      ) {
        const call = initializer.expression
        if (
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === 'json' &&
          ts.isIdentifier(call.expression.expression) &&
          responseSymbol &&
          checker?.getSymbolAtLocation(call.expression.expression)?.id === responseSymbol.id
        )
          responseToken = node.name.elements.find(
            (element) =>
              ts.isIdentifier(element.name) &&
              (element.propertyName?.text ?? element.name.text) === 'token',
          )?.name
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  if (
    keyDeclarations !== 1 ||
    !responseToken ||
    !responseSymbol ||
    responseToken.getStart() >= write.valueNode.getStart()
  )
    return false
  const bindings = tokenBindings(sourceFile)
  const responseBinding = resolveTokenBinding(responseToken, bindings, checker)
  const writeBinding = resolveTokenBinding(write.valueNode, bindings, checker)
  if (
    !responseBinding ||
    !writeBinding ||
    responseBinding.name.getStart() !== writeBinding.name.getStart()
  )
    return false
  let reassigned = false
  function inspect(node) {
    if (reassigned) return
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      const binding = resolveTokenBinding(node.left, bindings, checker)
      if (
        binding?.name.getStart() === responseBinding.name.getStart() ||
        checker?.getSymbolAtLocation(node.left)?.id === responseSymbol.id
      )
        reassigned = true
    }
    node.forEachChild(inspect)
  }
  inspect(body)
  return !reassigned
}

function checkStorageWrites(violations, root, path, source, sourceFile, checker) {
  const pathName = relativePath(root, path)
  const { writes } = storageWrites(sourceFile)
  for (const write of writes) {
    if (isDocumentedDevFallbackAst(pathName, sourceFile, write, checker)) continue
    violations.push(
      `${pathName}:${lineAt(source, write.index)}: browser storage write is forbidden (${write.keyArgument}); allowlist only permits the exact devLogin grant-token fallback`,
    )
  }
}

function checkCsp(violations, config) {
  const security = config?.app?.security
  const required = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
  }
  for (const name of ['csp', 'devCsp']) {
    const csp = security?.[name]
    if (!csp || typeof csp !== 'object' || Array.isArray(csp)) {
      violations.push(`${TAURI_CONFIG}: ${name} must be a non-empty object of CSP directives`)
      continue
    }
    const directives = { ...required, 'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'] }
    if (name === 'devCsp') directives['connect-src'].push('http://localhost:5174')
    for (const directive of Object.keys(directives)) {
      const value = csp[directive]
      if (typeof value !== 'string' || value.trim() === '') {
        violations.push(
          `${TAURI_CONFIG}: ${name} directive ${directive} must be a non-empty string`,
        )
        continue
      }
      const tokens = value.split(/\s+/).filter(Boolean)
      const allowed = new Set(directives[directive])
      const unsafe = tokens.find((token) => !allowed.has(token))
      if (unsafe) {
        violations.push(`${TAURI_CONFIG}: ${name} contains an unsafe CSP source ${unsafe}`)
      }
    }
    for (const directive of Object.keys(csp)) {
      if (!(directive in directives)) {
        violations.push(
          `${TAURI_CONFIG}: ${name} contains an unsupported CSP directive ${directive}`,
        )
      }
    }
  }
}

function permissionValues(value, key = '') {
  if (Array.isArray(value))
    return key === 'permissions' ? value.flatMap((item) => permissionValues(item, key)) : []
  if (!value || typeof value !== 'object')
    return key === 'permissions' && typeof value === 'string' ? [value] : []
  return Object.entries(value).flatMap(([childKey, child]) =>
    childKey === 'permissions' ||
    childKey.endsWith('permission') ||
    childKey.endsWith('permissions')
      ? permissionValues(child, 'permissions')
      : [],
  )
}

function checkCapability(violations, path, capability) {
  for (const permission of permissionValues(capability)) {
    if (
      /^(?:fs|filesystem|shell|opener|http)(?::|$)/i.test(permission) ||
      /plugin[-:]?http/i.test(permission)
    ) {
      violations.push(
        `${path}: capability permission ${permission} is forbidden (filesystem, shell, opener, and HTTP plugins are not allowed)`,
      )
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function validateTauriBoundary(root = process.cwd()) {
  const workspace = resolve(root)
  const violations = []
  const webRoot = resolve(workspace, WEB_DIRECTORY)
  const webSources = (await filesUnder(webRoot, true)).filter(isProductionWebSource)
  const typeScriptApi = new TypeScriptAPI({ cwd: workspace })
  const typeScriptSnapshot = typeScriptApi.updateSnapshot({ openFiles: webSources })
  try {
    for (const path of webSources) {
      if ((await lstat(path)).isSymbolicLink()) {
        violations.push(
          `${relativePath(workspace, path)}: symbolic links are forbidden in web source`,
        )
        continue
      }
      const project =
        typeScriptSnapshot.getDefaultProjectForFile(path) ?? typeScriptSnapshot.getProjects()[0]
      const sourceFile = project?.program.getSourceFile(path)
      if (!sourceFile) {
        violations.push(
          `${relativePath(workspace, path)}: unable to parse web source with TypeScript AST`,
        )
        continue
      }
      checkWebSource(
        violations,
        workspace,
        path,
        await readFile(path, 'utf8'),
        sourceFile,
        project?.checker,
      )
    }
  } finally {
    typeScriptSnapshot.dispose()
    typeScriptApi.close()
  }

  const configPath = resolve(workspace, TAURI_CONFIG)
  try {
    checkCsp(violations, await readJson(configPath))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      violations.push(`${TAURI_CONFIG}: required Tauri config file is missing`)
    } else throw error
  }

  const capabilityPath = resolve(workspace, CAPABILITIES_DIRECTORY, 'default.json')
  try {
    await readJson(capabilityPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      violations.push(
        `${relativePath(workspace, capabilityPath)}: required default capability file is missing`,
      )
    } else throw error
  }
  for (const path of await filesUnder(resolve(workspace, CAPABILITIES_DIRECTORY))) {
    if (extname(path).toLowerCase() !== '.json') continue
    checkCapability(violations, relativePath(workspace, path), await readJson(path))
  }

  for (const path of await filesUnder(resolve(workspace, TAURI_DIRECTORY))) {
    const pathName = relativePath(workspace, path)
    if (
      pathName.includes('/target/') ||
      pathName.includes('/gen/') ||
      pathName.endsWith('/icons/icon.png')
    )
      continue
    const source = await readFile(path, 'utf8')
    for (const secret of SECRET_NAMES) {
      const pattern = new RegExp(`\\b${secret}\\b`, 'g')
      for (const match of source.matchAll(pattern)) {
        violations.push(
          `${pathName}:${lineAt(source, match.index)}: server secret name ${secret} is forbidden in src-tauri`,
        )
      }
    }
  }

  return violations.sort()
}

export { validateTauriBoundary }

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const violations = await validateTauriBoundary(process.cwd())
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation)
    process.exitCode = 1
  }
}
