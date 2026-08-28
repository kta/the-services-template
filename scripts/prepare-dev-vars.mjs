#!/usr/bin/env node

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCAL_KEY_NAMES = [
  ['services/admin/.dev.vars', 'JWT_PRIVATE_KEY'],
  ['services/admin/.dev.vars', 'JWT_PUBLIC_KEY'],
  ['services/admin/.dev.vars', 'AUTH_DEV_PRIVATE_KEY'],
  ['services/example_service/.dev.vars', 'JWT_PUBLIC_KEY'],
  ['services/example_service/.dev.vars', 'AUTH_DEV_PRIVATE_KEY'],
]

const LOCAL_DEV_VAR_PATHS = [
  'services/admin/.dev.vars',
  'services/example_service/.dev.vars',
  'services/notifier/.dev.vars',
  'services/ops/.dev.vars',
]

function readValue(source, name) {
  const line = source.split('\n').find((candidate) => candidate.startsWith(`${name}=`))
  return line === undefined ? '' : line.slice(name.length + 1)
}

function setValue(source, name, value) {
  const lines = source.split('\n')
  const index = lines.findIndex((line) => line.startsWith(`${name}=`))
  if (index >= 0) {
    lines[index] = `${name}=${value}`
    return lines.join('\n')
  }
  return `${source.replace(/\s*$/, '')}\n${name}=${value}\n`
}

function compactPem(value) {
  return value.replace(/\r?\n/g, '')
}

function generateLocalPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  })
  return { privateKey: compactPem(privateKey), publicKey: compactPem(publicKey) }
}

function normalizePem(value) {
  const match = value.match(/^-----BEGIN ([A-Z ]+)-----([\s\S]+)-----END \1-----$/)
  if (!match) throw new Error('malformed PEM')
  const body = match[2].replace(/\s/g, '')
  if (!body) throw new Error('malformed PEM')
  return `-----BEGIN ${match[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${match[1]}-----\n`
}

function publicDerFromPrivate(value) {
  const privateKey = createPrivateKey(normalizePem(value))
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
}

function publicDer(value) {
  return createPublicKey(normalizePem(value)).export({ format: 'der', type: 'spki' })
}

function sameBytes(left, right) {
  return Buffer.compare(left, right) === 0
}

function readRegularDevFile(path, harden = true) {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error('local dev vars must not be symbolic links')
  if (!info.isFile()) throw new Error('local dev vars must be regular files')
  if (harden) chmodSync(path, 0o600)
  return readFileSync(path, 'utf8')
}

function ensureDevVarsFile(projectRoot, relativePath) {
  const path = join(projectRoot, relativePath)
  try {
    readRegularDevFile(path)
    return
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const examplePath = `${path}.example`
  const source = readRegularDevFile(examplePath, false)
  // O_EXCL (`wx`) makes a concurrent symlink/file insertion fail instead of
  // allowing the copy step to follow an attacker-controlled path.
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
}

function writeRegularDevFile(path, source) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('local dev vars must be regular files')
  }
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  chmodSync(path, 0o600)
}

function validateConfiguredPair(paths) {
  try {
    const adminPrivate = readValue(paths.get('services/admin/.dev.vars').source, 'JWT_PRIVATE_KEY')
    const adminPublic = readValue(paths.get('services/admin/.dev.vars').source, 'JWT_PUBLIC_KEY')
    const adminDevPrivate = readValue(
      paths.get('services/admin/.dev.vars').source,
      'AUTH_DEV_PRIVATE_KEY',
    )
    const examplePublic = readValue(
      paths.get('services/example_service/.dev.vars').source,
      'JWT_PUBLIC_KEY',
    )
    const exampleDevPrivate = readValue(
      paths.get('services/example_service/.dev.vars').source,
      'AUTH_DEV_PRIVATE_KEY',
    )
    const derivedPublic = publicDerFromPrivate(adminPrivate)
    if (!sameBytes(derivedPublic, publicDer(adminPublic))) {
      throw new Error('RSA key pair mismatch: admin public key')
    }
    if (!sameBytes(derivedPublic, publicDer(examplePublic))) {
      throw new Error('RSA key pair mismatch: example public key')
    }
    if (!sameBytes(derivedPublic, publicDerFromPrivate(adminDevPrivate))) {
      throw new Error('RSA key pair mismatch: admin dev key')
    }
    if (!sameBytes(derivedPublic, publicDerFromPrivate(exampleDevPrivate))) {
      throw new Error('RSA key pair mismatch: example dev key')
    }
  } catch (error) {
    throw new Error(`local RSA settings are malformed or mismatched: ${error.message}`)
  }
}

export function prepareDevVars(projectRoot) {
  for (const relativePath of LOCAL_DEV_VAR_PATHS) ensureDevVarsFile(projectRoot, relativePath)

  const paths = new Map()
  for (const [relativePath] of LOCAL_KEY_NAMES) {
    if (!paths.has(relativePath)) {
      const path = join(projectRoot, relativePath)
      paths.set(relativePath, { path, source: readFileSync(path, 'utf8') })
    }
  }

  // .dev.vars contains private development keys even when the values were
  // supplied by the developer. Normalize permissions before any early return.
  // The notifier/ops files do not contain RSA fields, so they are deliberately
  // not part of LOCAL_KEY_NAMES, but they still carry local credentials.
  for (const relativePath of LOCAL_DEV_VAR_PATHS) {
    const path = join(projectRoot, relativePath)
    readRegularDevFile(path)
  }

  const configured = LOCAL_KEY_NAMES.map(([relativePath, name]) =>
    Boolean(readValue(paths.get(relativePath).source, name)),
  )
  if (configured.some(Boolean) && !configured.every(Boolean)) {
    throw new Error(
      'all local RSA settings must be either empty or set; clear the partial pair and retry',
    )
  }
  if (configured.every(Boolean)) {
    validateConfiguredPair(paths)
    return
  }

  const { privateKey, publicKey } = generateLocalPair()
  const generated = {
    'services/admin/.dev.vars': {
      JWT_PRIVATE_KEY: privateKey,
      JWT_PUBLIC_KEY: publicKey,
      AUTH_DEV_PRIVATE_KEY: privateKey,
    },
    'services/example_service/.dev.vars': {
      JWT_PUBLIC_KEY: publicKey,
      AUTH_DEV_PRIVATE_KEY: privateKey,
    },
  }
  for (const [relativePath, values] of Object.entries(generated)) {
    const entry = paths.get(relativePath)
    let source = entry.source
    for (const [name, value] of Object.entries(values)) source = setValue(source, name, value)
    writeRegularDevFile(entry.path, source)
  }
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (scriptPath === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  prepareDevVars(projectRoot)
  console.log('local RSA dev keys are ready in ignored .dev.vars files')
}
