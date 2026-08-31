#!/usr/bin/env node

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadServiceRepositoryCatalog } from './service-catalog.mjs'

const ADMIN_DIRECTORY = 'admin'
const ADMIN_KEY_NAMES = ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'AUTH_DEV_PRIVATE_KEY']
const DOMAIN_KEY_NAMES = ['JWT_PUBLIC_KEY', 'AUTH_DEV_PRIVATE_KEY']

function isInside(root, path) {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function readValue(source, name) {
  const values = source
    .split('\n')
    .filter((candidate) => candidate.startsWith(`${name}=`))
    .map((candidate) => candidate.slice(name.length + 1))
  if (values.length > 1) throw new Error(`${name} must be declared exactly once`)
  return values[0] ?? ''
}

function requireVariable(source, name, relativePath) {
  const declarations = source
    .split('\n')
    .filter((candidate) => candidate.startsWith(`${name}=`)).length
  if (declarations !== 1) {
    throw new Error(`${relativePath} must declare ${name} exactly once`)
  }
}

function setValue(source, name, value) {
  const lines = source.split('\n')
  const matches = lines
    .map((line, index) => (line.startsWith(`${name}=`) ? index : -1))
    .filter((index) => index >= 0)
  if (matches.length !== 1) throw new Error(`${name} must be declared exactly once`)
  lines[matches[0]] = `${name}=${value}`
  return lines.join('\n')
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

function inspectRegularFile(path, label, containmentRoot) {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  if (!info.isFile()) throw new Error(`${label} must be a regular file`)
  const resolved = realpathSync(path)
  if (!isInside(containmentRoot, resolved)) {
    throw new Error(`${label} resolves outside its service directory`)
  }
  return readFileSync(resolved, 'utf8')
}

function createRegularDevFile(target, source) {
  // O_EXCL prevents a concurrent symlink or file insertion from redirecting
  // the initial copy to an attacker-controlled path.
  const descriptor = openSync(
    target.path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(descriptor, source, { encoding: 'utf8' })
    fchmodSync(descriptor, 0o600)
  } finally {
    closeSync(descriptor)
  }
}

function openRegularDevFile(target) {
  const descriptor = openSync(target.path, constants.O_RDWR | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile()) throw new Error(`${target.relativePath} must be a regular file`)
    const resolved = realpathSync(target.path)
    if (!isInside(target.serviceRoot, resolved)) {
      throw new Error(`${target.relativePath} resolves outside its service directory`)
    }
    return descriptor
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function makeRegularDevFileOwnerOnly(target) {
  const descriptor = openRegularDevFile(target)
  try {
    fchmodSync(descriptor, 0o600)
  } finally {
    closeSync(descriptor)
  }
}

function writeRegularDevFile(target, source) {
  const descriptor = openRegularDevFile(target)
  try {
    ftruncateSync(descriptor, 0)
    writeFileSync(descriptor, source, { encoding: 'utf8' })
    fchmodSync(descriptor, 0o600)
  } finally {
    closeSync(descriptor)
  }
}

function catalogTargets(projectRoot, projectReal, catalog) {
  const servicesRoot = realpathSync(join(projectRoot, 'services'))
  if (!isInside(projectReal, servicesRoot))
    throw new Error('services resolves outside project root')
  const entries = [...catalog.services, ...catalog.workerOnlyServices]
  const adminEntries = catalog.services.filter((service) => service.directory === ADMIN_DIRECTORY)
  if (adminEntries.length !== 1) {
    throw new Error('validated service catalog must contain exactly one admin SPA service')
  }

  return entries.map((service) => {
    const serviceRoot = realpathSync(join(servicesRoot, service.directory))
    if (!isInside(servicesRoot, serviceRoot)) {
      throw new Error(`services/${service.directory} resolves outside services`)
    }
    const relativePath = `services/${service.directory}/.dev.vars`
    return {
      directory: service.directory,
      domain: catalog.services.includes(service) && service.directory !== ADMIN_DIRECTORY,
      relativePath,
      exampleRelativePath: `${relativePath}.example`,
      path: join(serviceRoot, '.dev.vars'),
      examplePath: join(serviceRoot, '.dev.vars.example'),
      serviceRoot,
    }
  })
}

function validateConfiguredPair(paths, domainTargets) {
  try {
    const admin = paths.get(ADMIN_DIRECTORY)
    const adminPrivate = readValue(admin.source, 'JWT_PRIVATE_KEY')
    const adminPublic = readValue(admin.source, 'JWT_PUBLIC_KEY')
    const adminDevPrivate = readValue(admin.source, 'AUTH_DEV_PRIVATE_KEY')
    const derivedPublic = publicDerFromPrivate(adminPrivate)
    if (!sameBytes(derivedPublic, publicDer(adminPublic))) {
      throw new Error('RSA key pair mismatch: admin public key')
    }
    if (!sameBytes(derivedPublic, publicDerFromPrivate(adminDevPrivate))) {
      throw new Error('RSA key pair mismatch: admin dev key')
    }
    for (const target of domainTargets) {
      const source = paths.get(target.directory).source
      if (!sameBytes(derivedPublic, publicDer(readValue(source, 'JWT_PUBLIC_KEY')))) {
        throw new Error(`RSA key pair mismatch: ${target.directory} public key`)
      }
      if (
        !sameBytes(derivedPublic, publicDerFromPrivate(readValue(source, 'AUTH_DEV_PRIVATE_KEY')))
      ) {
        throw new Error(`RSA key pair mismatch: ${target.directory} dev key`)
      }
    }
    return { privateKey: adminPrivate, publicKey: adminPublic }
  } catch (error) {
    throw new Error(`local RSA settings are malformed or mismatched: ${error.message}`)
  }
}

function keyState(source, names, directory) {
  const values = Object.fromEntries(names.map((name) => [name, readValue(source, name)]))
  const configuredCount = Object.values(values).filter(Boolean).length
  if (configuredCount !== 0 && configuredCount !== names.length) {
    if (names.length === 2) {
      throw new Error(`${directory} local RSA settings must be both empty or both set`)
    }
    throw new Error(`all local RSA settings for ${directory} must be either empty or set`)
  }
  return { configured: configuredCount === names.length }
}

export async function prepareDevVars(projectRoot) {
  const root = resolve(projectRoot)
  const projectReal = realpathSync(root)
  const catalog = await loadServiceRepositoryCatalog(projectReal)
  const targets = catalogTargets(projectReal, projectReal, catalog)
  const domainTargets = targets.filter((target) => target.domain)

  // Inspect every catalog-derived source and existing target before creating
  // any file. This keeps an unsafe later entry from causing a partial copy.
  const inspected = new Map()
  for (const target of targets) {
    const exampleSource = inspectRegularFile(
      target.examplePath,
      target.exampleRelativePath,
      target.serviceRoot,
    )
    let source
    try {
      source = inspectRegularFile(target.path, target.relativePath, target.serviceRoot)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    inspected.set(target.directory, { target, exampleSource, source })
  }

  for (const { target, exampleSource, source } of inspected.values()) {
    if (source === undefined) createRegularDevFile(target, exampleSource)
    else makeRegularDevFileOwnerOnly(target)
  }

  const paths = new Map()
  for (const target of targets) {
    const source = inspectRegularFile(target.path, target.relativePath, target.serviceRoot)
    paths.set(target.directory, { target, source })
  }

  const admin = paths.get(ADMIN_DIRECTORY)
  for (const name of ADMIN_KEY_NAMES) requireVariable(admin.source, name, admin.target.relativePath)
  for (const target of domainTargets) {
    const entry = paths.get(target.directory)
    for (const name of DOMAIN_KEY_NAMES) requireVariable(entry.source, name, target.relativePath)
  }

  const adminState = keyState(admin.source, ADMIN_KEY_NAMES, ADMIN_DIRECTORY)
  const domainStates = new Map(
    domainTargets.map((target) => {
      const entry = paths.get(target.directory)
      return [target.directory, keyState(entry.source, DOMAIN_KEY_NAMES, target.directory)]
    }),
  )
  const configuredDomainTargets = domainTargets.filter(
    (target) => domainStates.get(target.directory).configured,
  )
  if (!adminState.configured && configuredDomainTargets.length > 0) {
    throw new Error('admin local RSA settings must be set before domain RSA settings')
  }

  const { privateKey, publicKey } = adminState.configured
    ? validateConfiguredPair(paths, configuredDomainTargets)
    : generateLocalPair()
  const unconfiguredDomainTargets = domainTargets.filter(
    (target) => !domainStates.get(target.directory).configured,
  )
  const generated = new Map([
    ...(!adminState.configured
      ? [
          [
            ADMIN_DIRECTORY,
            {
              JWT_PRIVATE_KEY: privateKey,
              JWT_PUBLIC_KEY: publicKey,
              AUTH_DEV_PRIVATE_KEY: privateKey,
            },
          ],
        ]
      : []),
    ...unconfiguredDomainTargets.map((target) => [
      target.directory,
      { JWT_PUBLIC_KEY: publicKey, AUTH_DEV_PRIVATE_KEY: privateKey },
    ]),
  ])
  for (const [directory, values] of generated) {
    const entry = paths.get(directory)
    let source = entry.source
    for (const [name, value] of Object.entries(values)) source = setValue(source, name, value)
    writeRegularDevFile(entry.target, source)
  }
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (scriptPath === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  await prepareDevVars(projectRoot)
  console.log('local RSA dev keys are ready in ignored .dev.vars files')
}
