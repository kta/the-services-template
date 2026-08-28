#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SERVICE_PATTERN = /^[a-z][a-z0-9_]*$/
const RESERVED_SERVICES = new Set(['admin', 'example_service', 'notifier', 'ops'])

function regularFile(path) {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Small comment-aware lexer used only for the production-readiness gate. The
 * gate must inspect executable tokens rather than accepting marker comments or
 * a module that merely declares the expected names. A full TypeScript compiler
 * is intentionally not required by this runtime script; the repository's
 * normal typecheck remains the semantic compiler gate.
 */
function tokensOf(source) {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2)
      index = newline === -1 ? source.length : newline + 1
      continue
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) return []
      index = end + 2
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character
      const start = index
      index += 1
      let escaped = false
      while (index < source.length) {
        const next = source[index]
        index += 1
        if (escaped) {
          escaped = false
        } else if (next === '\\') {
          escaped = true
        } else if (next === quote) {
          break
        }
      }
      if (source[index - 1] !== quote) return []
      tokens.push({ type: quote === '`' ? 'template' : 'string', text: source.slice(start, index) })
      continue
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)
    if (identifier) {
      tokens.push({ type: 'identifier', text: identifier[0] })
      index += identifier[0].length
      continue
    }
    const operator = source.slice(index).match(/^(?:=>|===|!==|==|!=|&&|\|\||\?\.|\?\?|\.{3})/)
    if (operator) {
      tokens.push({ type: 'punctuation', text: operator[0] })
      index += operator[0].length
      continue
    }
    tokens.push({ type: 'punctuation', text: character })
    index += 1
  }
  return tokens
}

function stringValue(token) {
  if (token?.type !== 'string') return null
  const quote = token.text[0]
  const body = token.text.slice(1, -1)
  if (quote === '"') {
    try {
      return JSON.parse(token.text)
    } catch {
      return null
    }
  }
  // Service names accepted by this gate contain only lowercase ASCII letters,
  // digits and underscores, so accepting an unescaped single-quoted literal is
  // sufficient and avoids evaluating source text.
  return /^[a-z0-9_]+$/.test(body) ? body : null
}

function rawStringValue(token) {
  if (token?.type !== 'string') return null
  if (token.text[0] === '"') {
    try {
      return JSON.parse(token.text)
    } catch {
      return null
    }
  }
  return token.text.slice(1, -1)
}

const CLOSING_DELIMITER = { '(': ')', '[': ']', '{': '}' }

function matchingDelimiter(tokens, start) {
  const expected = CLOSING_DELIMITER[tokens[start]?.text]
  if (!expected) return -1
  const stack = [expected]
  for (let index = start + 1; index < tokens.length; index += 1) {
    const text = tokens[index].text
    if (CLOSING_DELIMITER[text]) {
      stack.push(CLOSING_DELIMITER[text])
      continue
    }
    if (text !== stack.at(-1)) continue
    stack.pop()
    if (stack.length === 0) return index
  }
  return -1
}

function findExportedMiddlewareBody(tokens) {
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokens[index].text !== 'export') continue
    let nameIndex = -1
    let declarationEnd = index
    if (tokens[index + 1]?.text === 'const') {
      nameIndex = index + 2
      declarationEnd = index + 3
    } else if (tokens[index + 1]?.text === 'function') {
      nameIndex = index + 2
      declarationEnd = index + 3
    } else if (tokens[index + 1]?.text === 'async' && tokens[index + 2]?.text === 'function') {
      nameIndex = index + 3
      declarationEnd = index + 4
    }
    if (tokens[nameIndex]?.text !== 'productionAuthMiddleware') continue

    if (tokens[index + 1]?.text === 'function' || tokens[index + 2]?.text === 'function') {
      for (let cursor = declarationEnd; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor].text !== '{') continue
        const end = matchingDelimiter(tokens, cursor)
        if (end > cursor) return { start: cursor + 1, end: end - 1 }
        break
      }
      continue
    }

    if (tokens[declarationEnd]?.text !== '=') continue
    for (let cursor = declarationEnd + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].text === ';') break
      if (tokens[cursor].text !== '=>') continue
      const bodyStart = cursor + 1
      if (tokens[bodyStart]?.text !== '{') break
      const end = matchingDelimiter(tokens, bodyStart)
      if (end > bodyStart) return { start: bodyStart + 1, end: end - 1 }
      break
    }
  }
  return null
}

function hasCallInRange(tokens, start, end, names, requiredArgument) {
  const allowed = new Set(names)
  for (let index = start; index <= end; index += 1) {
    if (tokens[index]?.type !== 'identifier' || !allowed.has(tokens[index].text)) continue
    if (tokens[index + 1]?.text !== '(') continue
    const close = matchingDelimiter(tokens, index + 1)
    if (close < 0 || close > end + 1) continue
    if (
      !requiredArgument ||
      tokens
        .slice(index + 2, close)
        .some((token) => token.type === 'identifier' && token.text === requiredArgument)
    ) {
      return { start: index, end: close }
    }
  }
  return null
}

function hasDomainAudienceInMiddleware(tokens, body, service) {
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].text !== 'domainAccessTokenAudience') continue
    if (tokens[index + 1]?.text !== '(' || stringValue(tokens[index + 2]) !== service) continue
    const close = matchingDelimiter(tokens, index + 1)
    if (close < 0) continue
    if (index >= body.start && close <= body.end) return true

    // A module-level reviewed audience constant is acceptable only when that
    // exact binding is passed to the auth factory from the executable
    // middleware body. A dead marker or an unrelated constant is not.
    if (tokens[index - 1]?.text !== '=' || tokens[index - 2]?.type !== 'identifier') continue
    const binding = tokens[index - 2].text
    const authCall = hasCallInRange(
      tokens,
      body.start,
      body.end,
      ['tenantAuth', 'verifyAccessToken', 'verifyDomainAccessToken'],
      binding,
    )
    if (authCall) return true
  }
  return false
}

function hasStaticFalseBranch(tokens, start = 0, end = tokens.length - 1) {
  for (let index = start; index <= end - 3; index += 1) {
    if (tokens[index].text !== 'if' || tokens[index + 1]?.text !== '(') continue
    const conditionEnd = matchingDelimiter(tokens, index + 1)
    if (conditionEnd < 0 || conditionEnd > end) continue
    const condition = tokens.slice(index + 2, conditionEnd)
    if (!condition.some((token) => token.text === 'false' || token.text === '0')) continue
    const branchStart = conditionEnd + 1
    if (tokens[branchStart]?.text === '{') {
      const branchEnd = matchingDelimiter(tokens, branchStart)
      if (branchEnd > branchStart && branchEnd <= end) return true
    } else {
      return true
    }
  }
  return false
}

function hasEarlySuccessBeforeAuth(tokens, body, authCall) {
  for (let index = body.start; index < authCall.start; index += 1) {
    if (
      (tokens[index].text === 'return' && tokens[index + 1]?.text === 'next') ||
      (tokens[index].text === 'next' && tokens[index + 1]?.text === '(')
    ) {
      return true
    }
  }
  return false
}

function hasNamedImportFrom(tokens, names, moduleName) {
  const expectedNames = new Set(names)
  for (let index = 0; index < tokens.length - 4; index += 1) {
    if (tokens[index].text !== 'import') continue
    let upper = tokens.length
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].text === ';' || (cursor > index + 1 && tokens[cursor].text === 'import')) {
        upper = cursor
        break
      }
    }
    const moduleOffset = tokens
      .slice(index + 1, upper)
      .findIndex((token) => rawStringValue(token) === moduleName)
    if (moduleOffset < 0) continue
    const imported = tokens.slice(index + 1, index + 1 + moduleOffset)
    if (
      [...expectedNames].every((name) =>
        imported.some((token) => token.type === 'identifier' && token.text === name),
      )
    ) {
      return true
    }
  }
  return false
}

function importedLocalBinding(tokens, importedName, moduleName) {
  for (let index = 0; index < tokens.length - 4; index += 1) {
    if (tokens[index].text !== 'import') continue
    let upper = tokens.length
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].text === ';' || (cursor > index + 1 && tokens[cursor].text === 'import')) {
        upper = cursor
        break
      }
    }
    const moduleOffset = tokens
      .slice(index + 1, upper)
      .findIndex((token) => rawStringValue(token) === moduleName)
    if (moduleOffset < 0) continue
    const imported = tokens.slice(index + 1, index + 1 + moduleOffset)
    for (let cursor = 0; cursor < imported.length; cursor += 1) {
      if (imported[cursor].text !== importedName) continue
      return imported[cursor + 1]?.text === 'as' ? imported[cursor + 2]?.text : importedName
    }
  }
  return null
}

function hasExecutableShadow(tokens, name) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].text !== name) continue
    const previous = tokens[index - 1]?.text
    if (['const', 'let', 'var', 'function', 'class'].includes(previous)) return true
    // A function parameter can shadow an imported middleware even when the
    // body later calls the expected spelling. Reject the simple declaration
    // forms used by a fake/no-op production-auth module.
    if (previous === '(' && tokens[index - 2]?.text === 'function') return true
  }
  return false
}

function hasProductionAuthImport(tokens) {
  return Boolean(importedLocalBinding(tokens, 'productionAuthMiddleware', './production-auth'))
}

function hasProductionAuthTestImport(tokens) {
  return hasNamedImportFrom(tokens, ['productionAuthMiddleware'], '../src/worker/production-auth')
}

function hasNegativeAuthAssertion(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== 'status') continue
    for (let cursor = index + 1; cursor <= tokens.length - 3; cursor += 1) {
      const status = tokens
        .slice(cursor, cursor + 3)
        .map((token) => token.text)
        .join('')
      if (status === '401' || status === '403') return true
    }
  }
  return false
}

function hasTopLevelHonoAppBinding(tokens) {
  if (!hasNamedImportFrom(tokens, ['Hono'], 'hono') || hasExecutableShadow(tokens, 'Hono')) {
    return false
  }
  let braceDepth = 0
  for (let index = 0; index < tokens.length - 5; index += 1) {
    if (tokens[index].text === '{') {
      braceDepth += 1
      continue
    }
    if (tokens[index].text === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }
    if (
      braceDepth === 0 &&
      ['const', 'let', 'var'].includes(tokens[index].text) &&
      tokens[index + 1]?.text === 'app' &&
      tokens[index + 2]?.text === '=' &&
      tokens[index + 3]?.text === 'new' &&
      tokens[index + 4]?.text === 'Hono'
    ) {
      return true
    }
  }
  return false
}

function hasTopLevelProductionAuthUse(tokens, middlewareBinding = 'productionAuthMiddleware') {
  let braceDepth = 0
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].text === '{') {
      braceDepth += 1
      continue
    }
    if (tokens[index].text === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }
    if (
      braceDepth !== 0 ||
      tokens[index].text !== 'app' ||
      tokens[index + 1]?.text !== '.' ||
      tokens[index + 2]?.text !== 'use' ||
      tokens[index + 3]?.text !== '('
    )
      continue
    const close = matchingDelimiter(tokens, index + 3)
    if (
      close > index &&
      rawStringValue(tokens[index + 4]) === '/api/*' &&
      tokens
        .slice(index + 4, close)
        .some((token) => token.type === 'identifier' && token.text === middlewareBinding)
    ) {
      const firstRoute = firstTopLevelRouteRegistration(tokens)
      if (firstRoute >= 0 && index > firstRoute) return false
      return true
    }
  }
  return false
}

function firstTopLevelRouteRegistration(tokens) {
  let braceDepth = 0
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokens[index].text === '{') {
      braceDepth += 1
      continue
    }
    if (tokens[index].text === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }
    if (
      braceDepth === 0 &&
      tokens[index].text === 'app' &&
      tokens[index + 1]?.text === '.' &&
      ['get', 'post', 'put', 'patch', 'delete', 'all', 'route'].includes(tokens[index + 2]?.text) &&
      tokens[index + 3]?.text === '('
    ) {
      return index
    }
  }
  return -1
}

function hasExecutableAuthTest(tokens) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!['test', 'it'].includes(tokens[index].text) || tokens[index + 1].text !== '(') continue
    const close = matchingDelimiter(tokens, index + 1)
    if (close < 0) continue
    const callback = tokens.slice(index + 2, close)
    if (
      callback.some(
        (token) => token.type === 'identifier' && token.text === 'productionAuthMiddleware',
      ) &&
      hasCallInRange(tokens, index + 2, close - 1, ['use'], 'productionAuthMiddleware') &&
      hasCallInRange(tokens, index + 2, close - 1, ['expect', 'assert', 'assertEqual']) &&
      !hasStaticFalseBranch(tokens, index + 2, close - 1)
    ) {
      return true
    }
  }
  return false
}

/**
 * A copied domain is not production-ready just because it has a Worker and a
 * D1. The scaffold's only token endpoint is a credential-less development
 * grant, while its domain audience is intentionally different from admin's.
 * Requiring an explicit, tested production-auth module makes that gap fail
 * closed instead of turning a deploy into an unreachable or accidentally
 * weakened service.
 */
export function isProductionDomainAuthReady(service, rootDir = root) {
  if (!SERVICE_PATTERN.test(service) || RESERVED_SERVICES.has(service)) return false
  const serviceDir = resolve(rootDir, 'services', service)
  const authPath = join(serviceDir, 'src/worker/production-auth.ts')
  const workerPath = join(serviceDir, 'src/worker/index.ts')
  const testPath = join(serviceDir, 'test/production-auth.test.ts')
  if (![authPath, workerPath, testPath].every(regularFile)) return false

  let authSource
  let workerSource
  let testSource
  try {
    authSource = readFileSync(authPath, 'utf8')
    workerSource = readFileSync(workerPath, 'utf8')
    testSource = readFileSync(testPath, 'utf8')
  } catch {
    return false
  }

  const authTokens = tokensOf(authSource)
  const workerTokens = tokensOf(workerSource)
  const testTokens = tokensOf(testSource)
  const middlewareBody = findExportedMiddlewareBody(authTokens)
  // The module must be executable middleware, not a marker file. It must call
  // the canonical shared tenant JWT middleware with the reviewed domain
  // audience and the canonical active-organization middleware. The focused
  // test must import the real middleware and assert a rejected HTTP status;
  // prose, a local no-op, or `expect(true)` do not satisfy this gate.
  const tenantAuthBinding = importedLocalBinding(authTokens, 'tenantAuth', '@app/shared')
  const liveSessionBinding = importedLocalBinding(
    authTokens,
    'requireLiveDomainSession',
    '@app/shared',
  )
  const activeOrgBinding = importedLocalBinding(authTokens, 'requireActiveOrg', '@app/shared')
  const workerAuthBinding = importedLocalBinding(
    workerTokens,
    'productionAuthMiddleware',
    './production-auth',
  )
  if (
    !middlewareBody ||
    !hasDomainAudienceInMiddleware(authTokens, middlewareBody, service) ||
    !tenantAuthBinding ||
    !liveSessionBinding ||
    !activeOrgBinding ||
    hasExecutableShadow(authTokens, tenantAuthBinding) ||
    hasExecutableShadow(authTokens, liveSessionBinding) ||
    hasExecutableShadow(authTokens, activeOrgBinding) ||
    !hasCallInRange(authTokens, middlewareBody.start, middlewareBody.end, [tenantAuthBinding]) ||
    !hasCallInRange(authTokens, middlewareBody.start, middlewareBody.end, [liveSessionBinding]) ||
    !hasCallInRange(authTokens, middlewareBody.start, middlewareBody.end, [activeOrgBinding]) ||
    !hasNamedImportFrom(authTokens, ['domainAccessTokenAudience'], '@app/contracts') ||
    hasStaticFalseBranch(authTokens) ||
    hasEarlySuccessBeforeAuth(
      authTokens,
      middlewareBody,
      hasCallInRange(authTokens, middlewareBody.start, middlewareBody.end, [
        'tenantAuth',
        'verifyAccessToken',
        'verifyDomainAccessToken',
      ]),
    ) ||
    authTokens.some((token) => token.type === 'identifier' && token.text === 'AUTH_DEV_GRANT') ||
    authTokens.some((token) => token.type === 'identifier' && token.text === 'AUTH_DEV_PRIVATE_KEY')
  ) {
    return false
  }
  if (
    !hasProductionAuthImport(workerTokens) ||
    !workerAuthBinding ||
    hasExecutableShadow(workerTokens, workerAuthBinding) ||
    !hasTopLevelHonoAppBinding(workerTokens) ||
    !hasTopLevelProductionAuthUse(workerTokens, workerAuthBinding) ||
    hasStaticFalseBranch(workerTokens)
  ) {
    return false
  }
  return (
    hasProductionAuthTestImport(testTokens) &&
    hasExecutableAuthTest(testTokens) &&
    hasNegativeAuthAssertion(testTokens)
  )
}

export function requireProductionDomainAuth(service, rootDir = root) {
  if (!isProductionDomainAuthReady(service, rootDir)) {
    throw new Error(
      `production domain ${service} is blocked until a reviewed production-auth.ts middleware and test are added`,
    )
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const [service, ...unexpected] = process.argv.slice(2)
  if (unexpected.length > 0 || !service) {
    console.error(
      'production domain auth blocked: usage: require-production-domain-auth.mjs <service>',
    )
    process.exitCode = 1
  } else {
    try {
      requireProductionDomainAuth(service)
      console.log(`production domain auth: ${service} ready`)
    } catch (error) {
      console.error(`production domain auth blocked: ${error.message}`)
      process.exitCode = 1
    }
  }
}
