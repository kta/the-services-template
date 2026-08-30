#!/usr/bin/env node

import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript/unstable/ast'
import { API as TypeScriptAPI } from 'typescript/unstable/sync'
import { forbiddenSecretMarkersInText } from './secret-boundary.mjs'
import { validateServiceCatalog } from './service-catalog.mjs'

const TAURI_TARGETS = [
  {
    name: 'admin',
    webDirectory: 'services/admin/src/web',
    tauriDirectory: 'services/admin/src-tauri',
    tauriConfig: 'services/admin/src-tauri/tauri.conf.json',
    capabilitiesDirectory: 'services/admin/src-tauri/capabilities',
    devPort: 5174,
    storageAllowlist: new Map([
      [
        'services/admin/src/web/auth/session.ts',
        {
          key: 'app.admin.dev.token',
          logoutIntentKey: 'app.admin.logout.intent',
          reason: 'development-only fallback token; native sessions never use browser storage',
        },
      ],
    ]),
  },
  {
    name: 'example_tauri_service',
    webDirectory: 'services/example_tauri_service/src/web',
    tauriDirectory: 'services/example_tauri_service/src-tauri',
    tauriConfig: 'services/example_tauri_service/src-tauri/tauri.conf.json',
    capabilitiesDirectory: 'services/example_tauri_service/src-tauri/capabilities',
    devPort: 5175,
    storageAllowlist: new Map([
      [
        'services/example_tauri_service/src/web/auth/session.ts',
        {
          key: 'app.example_tauri_service.auth.token',
          organizationKey: 'app.example_tauri_service.auth.org',
          reason: 'Web-only dev session; native sessions never use browser storage',
        },
      ],
    ]),
  },
]
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const FORBIDDEN_WEB_PLUGIN_IMPORT =
  /(?:\bimport\s*(?:\(\s*)?|\bfrom\s+|\brequire\s*\(\s*)['"](@tauri-apps\/plugin-[^'"]+)['"]/g
const FORBIDDEN_TAURI_PLUGIN_REFERENCE =
  /(?:@tauri-apps\/plugin-[A-Za-z0-9_-]+|tauri-plugin-[A-Za-z0-9_-]+)/g
const CAPABILITY_EXTENSIONS = new Set(['.json', '.toml'])
async function filesUnder(directory, includeSymlinks = false) {
  try {
    const rootInfo = await lstat(directory)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
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

const MODULE_IMPORT_PATTERN =
  /(?:\b(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

function resolveLocalModule(importer, specifier, webRoot, sources) {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(importer), specifier)
  const candidates = []
  if (SOURCE_EXTENSIONS.has(extname(base))) candidates.push(base)
  else {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`)
    for (const extension of SOURCE_EXTENSIONS) candidates.push(join(base, `index${extension}`))
  }
  return candidates.find((candidate) => {
    const path = relative(webRoot, candidate)
    return !isAbsolute(path) && !path.startsWith('../') && sources.has(candidate)
  })
}

function importedWebSources(importer, source, webRoot, sources) {
  const imported = []
  MODULE_IMPORT_PATTERN.lastIndex = 0
  for (const match of source.matchAll(MODULE_IMPORT_PATTERN)) {
    const candidate = resolveLocalModule(importer, match[1], webRoot, sources)
    if (candidate) imported.push(candidate)
  }
  return imported
}

async function findImportedTestSources(webRoot, allSources, productionSources) {
  const sources = new Set(allSources)
  const visited = new Set()
  const importedTests = new Set()
  const queue = [...productionSources]
  while (queue.length > 0) {
    const importer = queue.pop()
    if (visited.has(importer)) continue
    visited.add(importer)
    const source = await readFile(importer, 'utf8')
    for (const imported of importedWebSources(importer, source, webRoot, sources)) {
      if (isTestSource(imported)) importedTests.add(imported)
      if (!visited.has(imported)) queue.push(imported)
    }
  }
  return [...importedTests].sort()
}

function isTransportSource(root, path, target) {
  return relativePath(root, path) === `${target.webDirectory}/platform/transport.ts`
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

function checkWebSource(violations, root, path, source, sourceFile, checker, target) {
  FORBIDDEN_WEB_PLUGIN_IMPORT.lastIndex = 0
  for (const match of source.matchAll(FORBIDDEN_WEB_PLUGIN_IMPORT)) {
    violations.push(
      `${relativePath(root, path)}:${lineAt(source, match.index)}: forbidden Tauri plugin import: ${match[1]}`,
    )
  }

  if (!isTransportSource(root, path, target)) {
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

  checkStorageWrites(violations, root, path, source, sourceFile, checker, target)
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
          (receiver.text === 'sessionStorage' || receiver.text === 'localStorage')
        add(
          node,
          node.arguments[0],
          node.arguments[1],
          exact ? `${receiver.text}.setItem` : 'indirect storage write',
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

function isDocumentedDevFallbackAst(pathName, sourceFile, write, checker, target) {
  const allow = target.storageAllowlist.get(pathName)
  if (!allow || !['sessionStorage.setItem', 'localStorage.setItem'].includes(write.shape))
    return false
  const isLogoutIntentWrite =
    allow.logoutIntentKey !== undefined &&
    write.keyArgument === 'LOGOUT_INTENT_KEY' &&
    ts.isStringLiteral(write.valueNode) &&
    write.valueNode.text === '1'
  if (isLogoutIntentWrite) {
    let logoutKeyDeclarations = 0
    function visitLogoutKey(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'LOGOUT_INTENT_KEY' &&
        stringValue(node.initializer) === allow.logoutIntentKey
      ) {
        logoutKeyDeclarations += 1
      }
      node.forEachChild(visitLogoutKey)
    }
    visitLogoutKey(sourceFile)
    return logoutKeyDeclarations === 1
  }
  const isTokenWrite =
    write.shape === 'sessionStorage.setItem' &&
    write.keyArgument === 'DEV_TOKEN_KEY' &&
    ts.isIdentifier(write.valueNode) &&
    write.valueArgument === 'token'
  const isOrganizationWrite =
    allow.organizationKey !== undefined &&
    write.keyArgument === 'DEV_ORG_KEY' &&
    ts.isIdentifier(write.valueNode) &&
    write.valueArgument === 'organizationId'
  if (!isTokenWrite && !isOrganizationWrite) return false

  const body = findDevLoginBodyAst(sourceFile)
  const platformFetchSymbol = platformFetchImportSymbol(sourceFile, checker)
  if (!body || !platformFetchSymbol || !isWithin(write.node, body)) return false
  let keyDeclarations = 0
  let organizationKeyDeclarations = 0
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
      if (
        isOrganizationWrite &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'DEV_ORG_KEY' &&
        stringValue(node.initializer) === allow.organizationKey
      )
        organizationKeyDeclarations += 1
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
    responseToken.getStart() >= write.valueNode.getStart() ||
    (isOrganizationWrite && organizationKeyDeclarations !== 1)
  )
    return false
  if (isOrganizationWrite) return true
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

function checkStorageWrites(violations, root, path, source, sourceFile, checker, target) {
  const pathName = relativePath(root, path)
  const { writes } = storageWrites(sourceFile)
  for (const write of writes) {
    if (isDocumentedDevFallbackAst(pathName, sourceFile, write, checker, target)) continue
    violations.push(
      `${pathName}:${lineAt(source, write.index)}: browser storage write is forbidden (${write.keyArgument}); allowlist only permits the exact devLogin grant-token fallback or logout tombstone`,
    )
  }
}

function checkCsp(violations, config, target) {
  const security = config?.app?.security
  const required = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
  }
  for (const name of ['csp', 'devCsp']) {
    const csp = security?.[name]
    if (!csp || typeof csp !== 'object' || Array.isArray(csp)) {
      violations.push(`${target.tauriConfig}: ${name} must be a non-empty object of CSP directives`)
      continue
    }
    const directives = { ...required, 'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'] }
    if (name === 'devCsp') {
      // Vite/Tauri development injects styles. Keep this exception confined to
      // devCsp; the release CSP must not permit inline styles.
      directives['style-src'].push("'unsafe-inline'")
      directives['connect-src'].push(
        `http://localhost:${target.devPort}`,
        `ws://localhost:${target.devPort}`,
        `ws://127.0.0.1:${target.devPort}`,
        'ws://localhost:1421',
        'ws://127.0.0.1:1421',
      )
    }
    for (const directive of Object.keys(directives)) {
      const value = csp[directive]
      if (typeof value !== 'string' || value.trim() === '') {
        violations.push(
          `${target.tauriConfig}: ${name} directive ${directive} must be a non-empty string`,
        )
        continue
      }
      const tokens = value.split(/\s+/).filter(Boolean)
      const allowed = new Set(directives[directive])
      const unsafe = tokens.find((token) => !allowed.has(token))
      if (unsafe) {
        violations.push(`${target.tauriConfig}: ${name} contains an unsafe CSP source ${unsafe}`)
      }
    }
    for (const directive of Object.keys(csp)) {
      if (!(directive in directives)) {
        violations.push(
          `${target.tauriConfig}: ${name} contains an unsupported CSP directive ${directive}`,
        )
      }
    }
  }
}

function jsonCapabilityPermissions(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray(value.permissions) ||
    value.permissions.some((permission) => typeof permission !== 'string')
  )
    return null
  return value.permissions
}

function tomlCapabilityArray(source, key) {
  const assignment = new RegExp(`(?:^|\\n)[ \\t]*${key}[ \\t]*=`, 'm').exec(source)
  if (!assignment) return null
  const equals = source.indexOf('=', assignment.index)
  const arrayStart = source.slice(equals + 1).search(/\[/)
  if (arrayStart < 0) return null
  const start = equals + 1 + arrayStart
  let depth = 0
  let quote = ''
  let escaped = false
  let comment = false
  let end = -1
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (comment) {
      if (char === '\n') comment = false
      continue
    }
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false
      } else if (quote === '"' && char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '#') {
      comment = true
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end < 0 || quote) return null

  const content = source.slice(start + 1, end)
  const values = []
  const strings = /"(?:\\.|[^"\\])*"|'[^']*'/g
  let cursor = 0
  for (const match of content.matchAll(strings)) {
    const gap = content
      .slice(cursor, match.index)
      .replace(/#[^\n]*/g, '')
      .replace(/[\s,]/g, '')
    if (gap !== '') return null
    const literal = match[0]
    if (literal.startsWith('"')) {
      try {
        values.push(JSON.parse(literal))
      } catch {
        return null
      }
    } else {
      values.push(literal.slice(1, -1))
    }
    cursor = match.index + literal.length
  }
  const tail = content
    .slice(cursor)
    .replace(/#[^\n]*/g, '')
    .replace(/[\s,]/g, '')
  return tail === '' ? values : null
}

function capabilityMetadata(source, extension) {
  try {
    if (extension === '.json') {
      const value = JSON.parse(source)
      return {
        permissions: jsonCapabilityPermissions(value),
        windows: Array.isArray(value?.windows) ? value.windows : null,
        hasRemote: Boolean(value && typeof value === 'object' && 'remote' in value),
        hasWebviews: Boolean(value && typeof value === 'object' && 'webviews' in value),
      }
    }
    if (extension === '.toml') {
      return {
        permissions: tomlCapabilityArray(source, 'permissions'),
        windows: tomlCapabilityArray(source, 'windows'),
        hasRemote: /(?:^|\n)[ \t]*remote[ \t]*=/m.test(source),
        hasWebviews: /(?:^|\n)[ \t]*webviews[ \t]*=/m.test(source),
      }
    }
    return null
  } catch {
    return null
  }
}

function checkCapability(violations, path, metadata) {
  const expected = path.startsWith('services/admin/')
    ? new Set(['allow-api-request', 'allow-clear-session'])
    : new Set(['allow-api-request'])
  if (!metadata) {
    violations.push(`${path}: capability could not be parsed safely`)
    return
  }
  if (metadata.hasRemote) {
    violations.push(`${path}: remote capability access is forbidden`)
  }
  if (metadata.hasWebviews) {
    violations.push(`${path}: webview capability access is forbidden`)
  }
  if (metadata.windows?.length !== 1 || metadata.windows[0] !== 'main') {
    violations.push(`${path}: capability must allow exactly the local main window`)
  }
  const permissions = metadata.permissions
  if (!permissions) {
    violations.push(
      `${path}: capability must declare permissions as a TOML/JSON array containing only allow-api-request`,
    )
    return
  }
  for (const permission of permissions) {
    if (!expected.has(permission)) {
      violations.push(`${path}: capability permission ${permission} is not allowed`)
    }
  }
  if (
    permissions.length !== expected.size ||
    !permissions.every((permission) => expected.has(permission))
  ) {
    violations.push(
      `${path}: capability must contain exactly the commands allowed for this service`,
    )
  }
}

function checkTauriWindows(violations, path, config) {
  const windows = config?.app?.windows
  if (!Array.isArray(windows) || windows.length !== 1) {
    violations.push(`${path}: Tauri config must declare exactly one local main window`)
    return
  }
  const [window] = windows
  if (!window || typeof window !== 'object' || Array.isArray(window) || window.label !== 'main') {
    violations.push(`${path}: Tauri config window must be labelled exactly main`)
  }
  if (window && typeof window === 'object' && !Array.isArray(window) && 'url' in window) {
    violations.push(`${path}: remote or separately-addressed Tauri window URLs are forbidden`)
  }
}

function checkTauriCapabilities(violations, path, config) {
  const capabilities = config?.app?.security?.capabilities
  if (!Array.isArray(capabilities) || capabilities.length !== 1 || capabilities[0] !== 'default') {
    violations.push(`${path}: Tauri config capability references must contain only default`)
  }
}

function checkTauriConfigPlugins(violations, path, config) {
  const app = config?.app
  if (
    config &&
    typeof config === 'object' &&
    ('plugins' in config || (app && typeof app === 'object' && 'plugins' in app))
  ) {
    violations.push(`${path}: plugins configuration is forbidden for this Tauri shell`)
  }
}

function checkTauriOverlaySecurity(violations, path, config) {
  const app = config?.app
  if (app && typeof app === 'object' && !Array.isArray(app) && 'security' in app) {
    violations.push(`${path}: security configuration is forbidden in platform overlays`)
  }
  if (app && typeof app === 'object' && !Array.isArray(app) && 'windows' in app) {
    violations.push(`${path}: window configuration is forbidden in platform overlays`)
  }
  if (config && typeof config === 'object' && !Array.isArray(config) && 'security' in config) {
    violations.push(`${path}: security configuration is forbidden in platform overlays`)
  }
  if (config && typeof config === 'object' && !Array.isArray(config) && 'windows' in config) {
    violations.push(`${path}: window configuration is forbidden in platform overlays`)
  }
}

function navigationGuardPattern(service) {
  const originEnv =
    service === 'admin'
      ? 'TAURI_ADMIN_API_ORIGIN'
      : `TAURI_${service.replaceAll('-', '_').toUpperCase()}_API_ORIGIN`
  return new RegExp(
    String.raw`\.plugin\(\s*tauri::plugin::Builder::<tauri::Wry>::new\("navigation-guard"\)\s*\.on_navigation\(\s*\|_,\s*url\|\s*\{\s*origin::navigation_allowed\(\s*url,\s*env!\("${originEnv}"\)\s*\)\s*\}\s*\)\s*\.build\(\),\s*\)`,
  )
}

function checkTauriPluginReferences(
  violations,
  path,
  source,
  checkConfig,
  allowedNavigationGuard = null,
) {
  let sourceForBuilderScan = source
  let foundAllowedNavigationGuard = false
  if (allowedNavigationGuard) {
    const match = source.match(allowedNavigationGuard)
    if (match && match.index !== undefined) {
      foundAllowedNavigationGuard = true
      sourceForBuilderScan = `${source.slice(0, match.index)}${source.slice(match.index + match[0].length)}`
    }
  }
  FORBIDDEN_TAURI_PLUGIN_REFERENCE.lastIndex = 0
  for (const match of source.matchAll(FORBIDDEN_TAURI_PLUGIN_REFERENCE)) {
    violations.push(
      `${path}:${lineAt(source, match.index)}: forbidden Tauri plugin reference: ${match[0]}`,
    )
  }
  if (/\.\s*plugin\s*\(/.test(sourceForBuilderScan)) {
    violations.push(`${path}: Tauri plugin builder calls are forbidden (.plugin())`)
  }
  if (checkConfig && extname(path).toLowerCase() === '.json') {
    try {
      checkTauriConfigPlugins(violations, path, JSON.parse(source))
    } catch {
      // JSON syntax errors are reported by the Tauri CLI; this checker only
      // needs to fail closed for a valid plugin configuration here.
    }
  }
  if (checkConfig && extname(path).toLowerCase() === '.toml') {
    if (/(?:^|\n)[ \t]*plugins[ \t]*=/m.test(source)) {
      violations.push(`${path}: plugins configuration is forbidden for this Tauri shell`)
    }
  }
  return foundAllowedNavigationGuard
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function isContainedPath(workspaceRealPath, path) {
  const rel = relative(workspaceRealPath, path)
  return (
    rel !== '..' &&
    !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(rel)
  )
}

async function validatePathType(workspace, relativeName, expected, violations) {
  const path = resolve(workspace, relativeName)
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      violations.push(
        `${relativeName}: symbolic links are forbidden; restore a regular ${expected}`,
      )
      return false
    }
    if (
      (expected === 'file' && !info.isFile()) ||
      (expected === 'directory' && !info.isDirectory())
    ) {
      violations.push(`${relativeName}: must be a regular ${expected}`)
      return false
    }
    const [resolved, workspaceRealPath] = await Promise.all([realpath(path), realpath(workspace)])
    if (!isContainedPath(workspaceRealPath, resolved)) {
      violations.push(`${relativeName}: real path resolves outside the workspace`)
      return false
    }
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    violations.push(`${relativeName}: cannot inspect required ${expected}: ${error.message}`)
    return false
  }
}

async function readJsonViolation(workspace, relativeName, violations) {
  if (!(await validatePathType(workspace, relativeName, 'file', violations))) return undefined
  try {
    return await readJson(resolve(workspace, relativeName))
  } catch (error) {
    violations.push(`${relativeName}: malformed JSON: ${error.message}`)
    return undefined
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function validateTemplateSeparation(workspace, services) {
  const violations = []
  for (const service of services.filter((candidate) => candidate.templateKind === 'web')) {
    const webRoot = `services/${service.directory}`
    const webTauriDirectory = `${webRoot}/src-tauri`
    if (await pathExists(resolve(workspace, webTauriDirectory))) {
      violations.push(
        `${webTauriDirectory}: Web-only ${service.directory} service must not contain a Tauri src-tauri directory; remove it or classify the service as tauri in service-catalog.json`,
      )
    }

    const webPackagePath = `${webRoot}/package.json`
    const packageJson = await readJsonViolation(workspace, webPackagePath, violations)
    if (!packageJson) continue
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const dependency of Object.keys(packageJson?.[section] ?? {})) {
        if (dependency.startsWith('@tauri-apps/')) {
          violations.push(
            `${webPackagePath}: Web-only ${service.directory} service has forbidden Tauri dependency ${dependency} in ${section}; remove it or classify the service as tauri in service-catalog.json`,
          )
        }
      }
    }
    for (const script of Object.keys(packageJson?.scripts ?? {})) {
      if (script === 'tauri' || script.startsWith('tauri:') || script.endsWith(':tauri')) {
        violations.push(
          `${webPackagePath}: Web-only ${service.directory} service has forbidden Tauri script ${script}; remove it or classify the service as tauri in service-catalog.json`,
        )
      }
    }
  }

  const requiredAssets = [
    'src-tauri/Cargo.toml',
    'src-tauri/tauri.conf.json',
    'src-tauri/capabilities/default.json',
    'src/web/platform/transport.ts',
    'src-tauri/src/origin.rs',
    'src-tauri/tauri.android.conf.json',
    'src-tauri/tauri.ios.conf.json',
    'src-tauri/tauri.macos.conf.json',
  ]
  for (const service of services.filter((candidate) => candidate.templateKind === 'tauri')) {
    const tauriRoot = `services/${service.directory}`
    for (const asset of requiredAssets) {
      const path = `${tauriRoot}/${asset}`
      if (!(await validatePathType(workspace, path, 'file', violations))) {
        violations.push(
          `${path}: Tauri service/template ${service.directory} is missing required asset ${asset}; restore the complete native service or change its catalog classification`,
        )
      }
    }

    const originPath = `${tauriRoot}/src-tauri/src/origin.rs`
    if (await validatePathType(workspace, originPath, 'file', violations)) {
      const source = await readFile(resolve(workspace, originPath), 'utf8')
      if (
        !/APPROVED_RELEASE_ORIGINS/.test(source) ||
        !/APPROVED_RELEASE_ORIGINS\.contains\(/.test(source)
      ) {
        violations.push(
          `${originPath}: Tauri service/template ${service.directory} must enforce its fixed APPROVED_RELEASE_ORIGINS allowlist`,
        )
      }
    }

    const transportPath = `${tauriRoot}/src/web/platform/transport.ts`
    if (await validatePathType(workspace, transportPath, 'file', violations)) {
      const source = await readFile(resolve(workspace, transportPath), 'utf8')
      if (
        !/@tauri-apps\/api\/core/.test(source) ||
        !/invoke(?:<[^>]+>)?\(\s*['"]api_request['"]/.test(source)
      ) {
        violations.push(
          `${transportPath}: Tauri service/template ${service.directory} must invoke the allowlisted native api_request command`,
        )
      }
    }

    for (const [asset, valid] of [
      ['tauri.android.conf.json', (config) => config?.bundle?.android?.minSdkVersion === 24],
      ['tauri.ios.conf.json', (config) => config?.bundle?.iOS?.minimumSystemVersion === '14.0'],
      [
        'tauri.macos.conf.json',
        (config) =>
          Array.isArray(config?.bundle?.targets) &&
          config.bundle.targets.length === 1 &&
          config.bundle.targets[0] === 'app' &&
          config?.bundle?.macOS?.minimumSystemVersion ===
            (service.directory === 'admin' ? '10.15' : '10.13'),
      ],
    ]) {
      const path = `${tauriRoot}/src-tauri/${asset}`
      const config = await readJsonViolation(workspace, path, violations)
      if (!config) continue
      if (!valid(config)) {
        violations.push(
          `${path}: Tauri service/template ${service.directory} ${asset} must retain the reviewed platform minimums and bundle target`,
        )
      }
    }
  }

  return violations
}

async function dynamicTauriTarget(workspace, service) {
  const configPath = resolve(workspace, `services/${service}/src-tauri/tauri.conf.json`)
  let devPort = 0
  try {
    const config = await readJson(configPath)
    const devUrl = config?.build?.devUrl
    if (typeof devUrl === 'string') {
      const url = new URL(devUrl)
      if (url.protocol === 'http:' && url.hostname === 'localhost' && url.port) {
        devPort = Number(url.port)
      }
    }
  } catch {
    // validateTarget reports the missing/malformed Tauri config. A zero port
    // keeps the CSP check fail closed until that config is repaired.
  }
  return {
    name: service,
    webDirectory: `services/${service}/src/web`,
    tauriDirectory: `services/${service}/src-tauri`,
    tauriConfig: `services/${service}/src-tauri/tauri.conf.json`,
    capabilitiesDirectory: `services/${service}/src-tauri/capabilities`,
    devPort,
    // A newly copied native shell must explicitly review every browser
    // storage write; inheriting the example dev allowlist would be unsafe.
    storageAllowlist: new Map(),
  }
}

async function catalogTauriTargets(workspace, services) {
  const known = new Map(TAURI_TARGETS.map((target) => [target.name, target]))
  return Promise.all(
    services
      .filter((service) => service.native)
      .map(
        (service) =>
          known.get(service.directory) ?? dynamicTauriTarget(workspace, service.directory),
      ),
  )
}

async function validateTarget(workspace, target) {
  const violations = []
  await validatePathType(workspace, target.tauriDirectory, 'directory', violations)
  const webRoot = resolve(workspace, target.webDirectory)
  const allWebSources = []
  for (const path of await filesUnder(webRoot, true)) {
    if ((await lstat(path)).isSymbolicLink()) {
      violations.push(
        `${relativePath(workspace, path)}: symbolic links are forbidden in web source`,
      )
      continue
    }
    if (isProductionWebSource(path)) allWebSources.push(path)
  }
  const everyWebSource = (await filesUnder(webRoot)).filter((path) =>
    SOURCE_EXTENSIONS.has(extname(path)),
  )
  const importedTestSources = await findImportedTestSources(webRoot, everyWebSource, allWebSources)
  for (const path of importedTestSources) {
    violations.push(
      `${relativePath(workspace, path)}: test/spec source is imported by production source and cannot bypass the native boundary check`,
    )
  }
  const webSources = [...allWebSources, ...importedTestSources]
  const typeScriptApi = new TypeScriptAPI({ cwd: workspace })
  const typeScriptSnapshot = typeScriptApi.updateSnapshot({ openFiles: webSources })
  try {
    for (const path of webSources) {
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
        target,
      )
    }
  } finally {
    typeScriptSnapshot.dispose()
    typeScriptApi.close()
  }

  const config = await readJsonViolation(workspace, target.tauriConfig, violations)
  if (config) {
    checkCsp(violations, config, target)
    checkTauriWindows(violations, target.tauriConfig, config)
    checkTauriCapabilities(violations, target.tauriConfig, config)
    checkTauriConfigPlugins(violations, target.tauriConfig, config)
  } else if (!(await pathExists(resolve(workspace, target.tauriConfig)))) {
    violations.push(`${target.tauriConfig}: required Tauri config file is missing`)
  }

  const capabilitiesRoot = resolve(workspace, target.capabilitiesDirectory)
  await validatePathType(workspace, target.capabilitiesDirectory, 'directory', violations)
  const capabilityFiles = []
  for (const path of await filesUnder(capabilitiesRoot, true)) {
    if ((await lstat(path)).isSymbolicLink()) {
      violations.push(`${relativePath(workspace, path)}: symbolic links are forbidden`)
      continue
    }
    if (CAPABILITY_EXTENSIONS.has(extname(path).toLowerCase())) capabilityFiles.push(path)
  }
  const defaultCapability = capabilityFiles.find((path) =>
    ['default.json', 'default.toml'].includes(basename(path).toLowerCase()),
  )
  if (!defaultCapability) {
    violations.push(
      `${relativePath(workspace, capabilitiesRoot)}/default.json or default.toml: required default capability file is missing`,
    )
  }
  for (const path of capabilityFiles) {
    const extension = extname(path).toLowerCase()
    checkCapability(
      violations,
      relativePath(workspace, path),
      capabilityMetadata(await readFile(path, 'utf8'), extension),
    )
  }

  let navigationGuardFound = false
  const navigationGuardPath = `${target.tauriDirectory}/src/lib.rs`
  for (const path of await filesUnder(resolve(workspace, target.tauriDirectory), true)) {
    const pathName = relativePath(workspace, path)
    if ((await lstat(path)).isSymbolicLink()) {
      violations.push(`${pathName}: symbolic links are forbidden in src-tauri`)
      continue
    }
    if (
      pathName.includes('/target/') ||
      pathName.includes('/gen/') ||
      pathName.endsWith('/icons/icon.png')
    )
      continue
    const source = await readFile(path, 'utf8')
    const isMainLibrary = pathName === navigationGuardPath
    const foundGuard = checkTauriPluginReferences(
      violations,
      pathName,
      source,
      pathName !== target.tauriConfig,
      isMainLibrary ? navigationGuardPattern(target.name) : null,
    )
    if (isMainLibrary) navigationGuardFound = foundGuard
    const isPlatformOverlay =
      pathName !== target.tauriConfig &&
      pathName.startsWith(`${target.tauriDirectory}/tauri.`) &&
      pathName.endsWith('.conf.json')
    if (isPlatformOverlay && extname(pathName).toLowerCase() === '.json') {
      try {
        checkTauriOverlaySecurity(violations, pathName, JSON.parse(source))
      } catch {
        // JSON syntax errors are reported by the Tauri CLI; the plugin and
        // secret scans above still apply to malformed files.
      }
    }
    for (const secret of forbiddenSecretMarkersInText(source)) {
      let offset = source.indexOf(secret)
      while (offset >= 0) {
        violations.push(
          `${pathName}:${lineAt(source, offset)}: server secret name ${secret} is forbidden in src-tauri`,
        )
        offset = source.indexOf(secret, offset + secret.length)
      }
    }
  }
  if (!navigationGuardFound) {
    violations.push(`${navigationGuardPath}: exact top-level navigation guard plugin is required`)
  }

  return violations.sort()
}

async function validateTauriBoundary(root = process.cwd()) {
  const workspace = resolve(root)
  const catalog = await validateServiceCatalog(workspace)
  const targets = await catalogTauriTargets(workspace, catalog.services)
  const [templateViolations, targetViolations] = await Promise.all([
    validateTemplateSeparation(workspace, catalog.services),
    Promise.all(targets.map((target) => validateTarget(workspace, target))),
  ])
  return [
    ...catalog.violations.map((violation) => `service catalog: ${violation}`),
    ...templateViolations,
    ...targetViolations.flat(),
  ].sort()
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
