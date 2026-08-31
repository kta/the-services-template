import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseGithubWorkflow } from './workflow-policy.mjs'

const workflow = parseGithubWorkflow(
  readFileSync('.github/workflows/production-bootstrap.yml', 'utf8'),
)
const policyBody = workflow.jobs.bootstrap.steps.find(
  (step) => step.name === 'Bootstrap production Workers with fixed secret bundles',
)?.run
assert.equal(typeof policyBody, 'string')
const bash = existsSync('/opt/homebrew/bin/bash') ? '/opt/homebrew/bin/bash' : '/bin/bash'

function normalizedPem(value) {
  const match = value.match(/^-----BEGIN ([A-Z ]+KEY)-----([A-Za-z0-9+/=\r\n]+)-----END \1-----$/)
  assert.ok(match)
  const payload = match[2].replace(/\s+/g, '')
  return `-----BEGIN ${match[1]}-----\n${payload.match(/.{1,64}/g).join('\n')}\n-----END ${match[1]}-----\n`
}

function committedKey(name) {
  const source = readFileSync('packages/shared/test/jwt-keys.ts', 'utf8')
  const match = source.match(new RegExp(`export const ${name} =\\s*\\n?\\s*'([^']+)'`))
  assert.ok(match, `${name} fixture must exist`)
  return normalizedPem(match[1])
}

function rsaPair(modulusLength) {
  const pair = generateKeyPairSync('rsa', { modulusLength })
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function ecPair() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function opaqueSecrets() {
  return Object.fromEntries(
    [
      'PRODUCTION_DOMAIN_TO_ADMIN_KEY',
      'PRODUCTION_ADMIN_TO_DOMAIN_KEY',
      'PRODUCTION_ADMIN_TO_NOTIFIER_KEY',
      'PRODUCTION_DOMAIN_TO_NOTIFIER_KEY',
      'PRODUCTION_OPS_TO_NOTIFIER_KEY',
      'PRODUCTION_AUTH_PEPPER',
      'PRODUCTION_RESEND_API_KEY',
      'PRODUCTION_D1_EXPORT_API_TOKEN',
      'PRODUCTION_R2_POLICY_CHECK_API_TOKEN',
    ].map((name) => [name, randomBytes(32).toString('hex')]),
  )
}

function runPolicy({ jwt, backup }) {
  const runnerTemp = mkdtempSync(join(tmpdir(), 'production-bootstrap-policy-'))
  const result = spawnSync(bash, ['-c', policyBody], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: runnerTemp,
      DOMAIN_SERVICE: 'booking',
      PRODUCTION_JWT_PRIVATE_KEY: jwt.privateKey,
      PRODUCTION_JWT_PUBLIC_KEY: jwt.publicKey,
      PRODUCTION_BACKUP_SIGNING_PRIVATE_KEY: backup.privateKey,
      REVIEWED_BACKUP_SIGNING_PUBLIC_KEY_B64: Buffer.from(backup.publicKey).toString('base64'),
      ...opaqueSecrets(),
    },
  })
  return {
    result,
    wroteBundle: existsSync(join(runnerTemp, 'production-secret-bundles')),
    cleanup() {
      rmSync(runnerTemp, { recursive: true, force: true })
    },
  }
}

test('exact bootstrap policy accepts distinct RSA pairs of at least 2048 bits', () => {
  const execution = runPolicy({ jwt: rsaPair(2048), backup: rsaPair(2048) })
  try {
    assert.equal(
      execution.result.status,
      0,
      `${execution.result.stderr}\n${execution.result.stdout}\n${execution.result.error ?? ''}`,
    )
    assert.equal(execution.wroteBundle, true)
  } finally {
    execution.cleanup()
  }
})

test('exact bootstrap policy rejects the committed key in either signing role before writing', () => {
  const committed = {
    privateKey: committedKey('JWT_TEST_PRIVATE_KEY'),
    publicKey: committedKey('JWT_TEST_PUBLIC_KEY'),
  }
  for (const [label, jwt, backup] of [
    ['JWT', committed, rsaPair(2048)],
    ['backup signer', rsaPair(2048), committed],
  ]) {
    const execution = runPolicy({ jwt, backup })
    try {
      assert.notEqual(execution.result.status, 0, label)
      assert.match(execution.result.stderr, /committed test key/i, label)
      assert.equal(execution.wroteBundle, false, label)
    } finally {
      execution.cleanup()
    }
  }
})

test('exact bootstrap policy rejects mismatched JWT and backup pairs before writing', () => {
  const jwt = rsaPair(2048)
  const backup = rsaPair(2048)
  for (const [label, invalidJwt, invalidBackup] of [
    ['JWT', { privateKey: jwt.privateKey, publicKey: rsaPair(2048).publicKey }, backup],
    ['backup signer', jwt, { privateKey: backup.privateKey, publicKey: rsaPair(2048).publicKey }],
  ]) {
    const execution = runPolicy({ jwt: invalidJwt, backup: invalidBackup })
    try {
      assert.notEqual(execution.result.status, 0, label)
      assert.match(execution.result.stderr, /pair mismatch|does not match/i, label)
      assert.equal(execution.wroteBundle, false, label)
    } finally {
      execution.cleanup()
    }
  }
})

test('exact bootstrap policy rejects non-RSA and undersized RSA material before writing', () => {
  for (const [label, jwt, backup] of [
    ['EC JWT', ecPair(), rsaPair(2048)],
    ['1024-bit JWT', rsaPair(1024), rsaPair(2048)],
    ['1024-bit backup signer', rsaPair(2048), rsaPair(1024)],
  ]) {
    const execution = runPolicy({ jwt, backup })
    try {
      assert.notEqual(execution.result.status, 0, label)
      assert.match(execution.result.stderr, /RSA.*at least 2048 bits/i, label)
      assert.equal(execution.wroteBundle, false, label)
    } finally {
      execution.cleanup()
    }
  }
})
