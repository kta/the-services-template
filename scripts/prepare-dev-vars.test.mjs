import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareDevVars } from './prepare-dev-vars.mjs'

function envValues(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      }),
  )
}

function multilinePem(value, label) {
  const header = `-----BEGIN ${label}-----`
  const footer = `-----END ${label}-----`
  const body = value.slice(header.length, -footer.length)
  return `${header}\n${body.match(/.{1,64}/g).join('\n')}\n${footer}\n`
}

const privateKeyHeader = pemLabel('PRIVATE KEY')

function pemLabel(label) {
  return `-----BEGIN ${label}-----`
}

function writeNonAuthExamples(root) {
  mkdirSync(join(root, 'services/notifier'), { recursive: true })
  mkdirSync(join(root, 'services/ops'), { recursive: true })
  writeFileSync(join(root, 'services/notifier/.dev.vars.example'), 'RESEND_API_KEY=\n')
  writeFileSync(join(root, 'services/ops/.dev.vars.example'), 'D1_EXPORT_API_TOKEN=\n')
}

test('generates one local RSA pair without overwriting existing dev vars', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepare-dev-vars-'))
  const adminPath = join(root, 'services/admin/.dev.vars')
  const examplePath = join(root, 'services/example_service/.dev.vars')
  const notifierPath = join(root, 'services/notifier/.dev.vars')
  const opsPath = join(root, 'services/ops/.dev.vars')
  mkdirSync(join(root, 'services/admin'), { recursive: true })
  mkdirSync(join(root, 'services/example_service'), { recursive: true })
  mkdirSync(join(root, 'services/notifier'), { recursive: true })
  mkdirSync(join(root, 'services/ops'), { recursive: true })
  writeFileSync(adminPath, 'JWT_PRIVATE_KEY=\nJWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\n')
  writeFileSync(examplePath, 'JWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\n')
  writeFileSync(notifierPath, 'RESEND_API_KEY=dev\n', { mode: 0o644 })
  writeFileSync(opsPath, 'D1_EXPORT_API_TOKEN=dev\n', { mode: 0o644 })

  prepareDevVars(root)
  const admin = envValues(adminPath)
  const example = envValues(examplePath)
  assert.match(
    admin.JWT_PRIVATE_KEY,
    new RegExp(`^${privateKeyHeader}.*-----END PRIVATE KEY-----$`),
  )
  assert.match(
    admin.JWT_PUBLIC_KEY,
    new RegExp(`^${pemLabel('PUBLIC KEY')}.*-----END PUBLIC KEY-----$`),
  )
  assert.equal(example.JWT_PUBLIC_KEY, admin.JWT_PUBLIC_KEY)
  assert.equal(example.AUTH_DEV_PRIVATE_KEY, admin.JWT_PRIVATE_KEY)
  assert.equal(admin.AUTH_DEV_PRIVATE_KEY, admin.JWT_PRIVATE_KEY)
  assert.equal(statSync(adminPath).mode & 0o777, 0o600)
  assert.equal(statSync(examplePath).mode & 0o777, 0o600)
  assert.equal(statSync(notifierPath).mode & 0o777, 0o600)
  assert.equal(statSync(opsPath).mode & 0o777, 0o600)

  const derivedPublic = createPublicKey(
    createPrivateKey({
      key: multilinePem(admin.JWT_PRIVATE_KEY, 'PRIVATE KEY'),
      format: 'pem',
      type: 'pkcs8',
    }),
  ).export({ format: 'der', type: 'spki' })
  const configuredPublic = createPublicKey({
    key: multilinePem(example.JWT_PUBLIC_KEY, 'PUBLIC KEY'),
    format: 'pem',
    type: 'spki',
  }).export({ format: 'der', type: 'spki' })
  assert.deepEqual(derivedPublic, configuredPublic)

  const beforeAdmin = readFileSync(adminPath, 'utf8')
  const beforeExample = readFileSync(examplePath, 'utf8')
  prepareDevVars(root)
  assert.equal(readFileSync(adminPath, 'utf8'), beforeAdmin)
  assert.equal(readFileSync(examplePath, 'utf8'), beforeExample)
})

test('fails closed when only part of the local pair is configured', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepare-dev-vars-partial-'))
  mkdirSync(join(root, 'services/admin'), { recursive: true })
  mkdirSync(join(root, 'services/example_service'), { recursive: true })
  writeNonAuthExamples(root)
  writeFileSync(
    join(root, 'services/admin/.dev.vars'),
    'JWT_PRIVATE_KEY=private\nJWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\n',
  )
  writeFileSync(
    join(root, 'services/example_service/.dev.vars'),
    'JWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\n',
  )

  assert.throws(() => prepareDevVars(root), /all local RSA settings|both empty or both set/)
})

test('fails closed when all local RSA fields are non-empty but malformed', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepare-dev-vars-malformed-'))
  mkdirSync(join(root, 'services/admin'), { recursive: true })
  mkdirSync(join(root, 'services/example_service'), { recursive: true })
  writeNonAuthExamples(root)
  writeFileSync(
    join(root, 'services/admin/.dev.vars'),
    'JWT_PRIVATE_KEY=not-a-key\nJWT_PUBLIC_KEY=not-a-key\nAUTH_DEV_PRIVATE_KEY=not-a-key\n',
  )
  writeFileSync(
    join(root, 'services/example_service/.dev.vars'),
    'JWT_PUBLIC_KEY=not-a-key\nAUTH_DEV_PRIVATE_KEY=not-a-key\n',
  )

  assert.throws(() => prepareDevVars(root), /malformed|RSA key pair/)
})
