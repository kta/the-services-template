import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareDevVars } from './prepare-dev-vars.mjs'

const repositoryRoot = process.cwd()
const nativePackageScripts = {
  'build:tauri': 'node ../../scripts/native-workflow.mjs package build',
  tauri: 'node ../../scripts/native-workflow.mjs package tauri',
}

function writeFixture(root, relativePath, source, options) {
  const path = join(root, relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, source, options)
}

function writeService(root, directory, packageJson, example) {
  writeFixture(root, `services/${directory}/package.json`, `${JSON.stringify(packageJson)}\n`)
  writeFixture(root, `services/${directory}/src/web/App.tsx`, 'export {}\n')
  writeFixture(root, `services/${directory}/.dev.vars.example`, example)
}

function writeRepositoryFixture(root) {
  for (const relativePath of [
    'Makefile',
    'scripts/prepare-dev-vars.mjs',
    'scripts/service-catalog.mjs',
    'scripts/workflow-policy.mjs',
    'scripts/check-production-config.mjs',
  ]) {
    writeFixture(root, relativePath, readFileSync(join(repositoryRoot, relativePath), 'utf8'))
  }
  const services = [
    {
      directory: 'admin',
      package: '@app/admin',
      templateKind: 'tauri',
      deployable: true,
      native: true,
      nativeWorkflow: '.github/workflows/tauri-build.yml',
    },
    {
      directory: 'example_service',
      package: '@app/example_service',
      templateKind: 'web',
      deployable: false,
      native: false,
    },
    {
      directory: 'example_tauri_service',
      package: '@app/example_tauri_service',
      templateKind: 'tauri',
      deployable: false,
      native: true,
      nativeWorkflow: '.github/workflows/example-tauri-build.yml',
    },
    {
      directory: 'booking',
      package: '@app/booking',
      templateKind: 'web',
      deployable: false,
      native: false,
    },
  ]
  const workerOnlyServices = [
    { directory: 'notifier', package: '@app/notifier', deployable: true },
    { directory: 'ops', package: '@app/ops', deployable: true },
  ]
  writeFixture(
    root,
    'service-catalog.json',
    `${JSON.stringify({ services, workerOnlyServices })}\n`,
  )
  writeFixture(
    root,
    '.github/workflows/tauri-build.yml',
    readFileSync(join(repositoryRoot, '.github/workflows/tauri-build.yml'), 'utf8'),
  )
  writeFixture(
    root,
    '.github/workflows/example-tauri-build.yml',
    readFileSync(join(repositoryRoot, '.github/workflows/example-tauri-build.yml'), 'utf8'),
  )

  writeService(
    root,
    'admin',
    { name: '@app/admin', scripts: nativePackageScripts },
    'APP_ENV=development\nJWT_PRIVATE_KEY=\nJWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\n',
  )
  for (const directory of ['example_service', 'example_tauri_service', 'booking']) {
    writeService(
      root,
      directory,
      {
        name: `@app/${directory}`,
        ...(directory === 'example_tauri_service' ? { scripts: nativePackageScripts } : {}),
      },
      `APP_ENV=development\nJWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\nSERVICE_SENTINEL=${directory}\n`,
    )
  }
  for (const directory of ['notifier', 'ops']) {
    writeFixture(
      root,
      `services/${directory}/package.json`,
      `${JSON.stringify({
        name: `@app/${directory}`,
        scripts: { build: 'wrangler deploy --dry-run', test: 'vitest run' },
      })}\n`,
    )
    writeFixture(root, `services/${directory}/src/index.ts`, 'export {}\n')
    writeFixture(root, `services/${directory}/wrangler.jsonc`, '{\n  "main": "src/index.ts"\n}\n')
    writeFixture(
      root,
      `services/${directory}/.dev.vars.example`,
      `${directory.toUpperCase()}_SENTINEL=development\n`,
    )
  }
}

function addCopiedService(root, { directory, templateKind, devVars }) {
  const catalogPath = join(root, 'service-catalog.json')
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  const native = templateKind === 'tauri'
  const nativeWorkflow = `.github/workflows/${directory.replaceAll('_', '-')}-build.yml`
  catalog.services.push({
    directory,
    package: `@app/${directory}`,
    templateKind,
    deployable: false,
    native,
    ...(native ? { nativeWorkflow } : {}),
  })
  writeFixture(root, 'service-catalog.json', `${JSON.stringify(catalog)}\n`)
  if (native) {
    const workflow = readFileSync(
      join(repositoryRoot, '.github/workflows/example-tauri-build.yml'),
      'utf8',
    )
      .replaceAll('example_tauri_service', directory)
      .replaceAll('example-tauri-service', directory.replaceAll('_', '-'))
    writeFixture(root, nativeWorkflow, workflow)
  }
  writeService(
    root,
    directory,
    { name: `@app/${directory}`, ...(native ? { scripts: nativePackageScripts } : {}) },
    `APP_ENV=development\nJWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\nSERVICE_SENTINEL=${directory}\n`,
  )
  if (devVars !== undefined) {
    writeFixture(root, `services/${directory}/.dev.vars`, devVars)
  }
}

function freshFixture(t, prefix = 'prepare-dev-vars-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeRepositoryFixture(root)
  return root
}

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

function pemLabel(label) {
  return `-----BEGIN ${label}-----`
}

const privateKeyHeader = pemLabel('PRIVATE KEY')
const domains = ['example_service', 'example_tauri_service', 'booking']
const allServices = ['admin', ...domains, 'notifier', 'ops']

test('fresh make init/dev-vars copies every catalog service and distributes one local RSA pair', async (t) => {
  const root = freshFixture(t)

  const initPlan = execFileSync('make', ['--dry-run', 'init'], { cwd: root, encoding: 'utf8' })
  assert.match(initPlan, /make(?:\[[0-9]+\])? dev-vars/)
  execFileSync('make', ['dev-vars'], { cwd: root, stdio: 'pipe' })

  const adminPath = join(root, 'services/admin/.dev.vars')
  const admin = envValues(adminPath)
  assert.match(
    admin.JWT_PRIVATE_KEY,
    new RegExp(`^${privateKeyHeader}.*-----END PRIVATE KEY-----$`),
  )
  assert.match(
    admin.JWT_PUBLIC_KEY,
    new RegExp(`^${pemLabel('PUBLIC KEY')}.*-----END PUBLIC KEY-----$`),
  )
  assert.equal(admin.AUTH_DEV_PRIVATE_KEY, admin.JWT_PRIVATE_KEY)

  for (const directory of domains) {
    const values = envValues(join(root, `services/${directory}/.dev.vars`))
    assert.equal(values.JWT_PUBLIC_KEY, admin.JWT_PUBLIC_KEY, directory)
    assert.equal(values.AUTH_DEV_PRIVATE_KEY, admin.JWT_PRIVATE_KEY, directory)
    assert.equal(values.SERVICE_SENTINEL, directory)
  }
  for (const directory of allServices) {
    assert.equal(statSync(join(root, `services/${directory}/.dev.vars`)).mode & 0o777, 0o600)
  }
  assert.equal(
    envValues(join(root, 'services/notifier/.dev.vars')).NOTIFIER_SENTINEL,
    'development',
  )
  assert.equal(envValues(join(root, 'services/ops/.dev.vars')).OPS_SENTINEL, 'development')

  const derivedPublic = createPublicKey(
    createPrivateKey({
      key: multilinePem(admin.JWT_PRIVATE_KEY, 'PRIVATE KEY'),
      format: 'pem',
      type: 'pkcs8',
    }),
  ).export({ format: 'der', type: 'spki' })
  const configuredPublic = createPublicKey({
    key: multilinePem(
      envValues(join(root, 'services/example_tauri_service/.dev.vars')).JWT_PUBLIC_KEY,
      'PUBLIC KEY',
    ),
    format: 'pem',
    type: 'spki',
  }).export({ format: 'der', type: 'spki' })
  assert.deepEqual(derivedPublic, configuredPublic)

  const before = new Map(
    allServices.map((directory) => [
      directory,
      readFileSync(join(root, `services/${directory}/.dev.vars`), 'utf8'),
    ]),
  )
  await prepareDevVars(root)
  for (const [directory, source] of before) {
    assert.equal(readFileSync(join(root, `services/${directory}/.dev.vars`), 'utf8'), source)
  }
})

test('incremental Web and Tauri services reuse the verified local RSA pair without changing existing values', async (t) => {
  for (const scenario of [
    { directory: 'copied_web', templateKind: 'web', devVars: undefined },
    {
      directory: 'copied_tauri',
      templateKind: 'tauri',
      devVars:
        'APP_ENV=development\nJWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\nSERVICE_SENTINEL=copied_tauri\n',
    },
  ]) {
    await t.test(
      `${scenario.templateKind} with ${scenario.devVars ? 'empty' : 'missing'} .dev.vars`,
      async (t) => {
        const root = freshFixture(t, `prepare-dev-vars-incremental-${scenario.templateKind}-`)
        await prepareDevVars(root)
        const existing = new Map(
          allServices.map((directory) => [
            directory,
            readFileSync(join(root, `services/${directory}/.dev.vars`), 'utf8'),
          ]),
        )
        const admin = envValues(join(root, 'services/admin/.dev.vars'))

        addCopiedService(root, scenario)
        await prepareDevVars(root)

        for (const [directory, source] of existing) {
          assert.equal(
            readFileSync(join(root, `services/${directory}/.dev.vars`), 'utf8'),
            source,
            `${directory} must not be overwritten`,
          )
        }
        const copiedPath = join(root, `services/${scenario.directory}/.dev.vars`)
        const copied = envValues(copiedPath)
        assert.equal(copied.JWT_PUBLIC_KEY, admin.JWT_PUBLIC_KEY)
        assert.equal(copied.AUTH_DEV_PRIVATE_KEY, admin.JWT_PRIVATE_KEY)
        assert.equal(copied.SERVICE_SENTINEL, scenario.directory)
        assert.equal(statSync(copiedPath).mode & 0o777, 0o600)
      },
    )
  }
})

test('fails closed when only part of the admin local pair is configured', async (t) => {
  const root = freshFixture(t, 'prepare-dev-vars-partial-')
  writeFixture(
    root,
    'services/admin/.dev.vars',
    'JWT_PRIVATE_KEY=private\nJWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\n',
  )

  await assert.rejects(
    async () => prepareDevVars(root),
    /all local RSA settings|both empty or both set/,
  )
})

test('fails closed when a configured domain has only one local RSA field', async (t) => {
  const root = freshFixture(t, 'prepare-dev-vars-domain-partial-')
  await prepareDevVars(root)
  const booking = envValues(join(root, 'services/booking/.dev.vars'))
  writeFixture(
    root,
    'services/booking/.dev.vars',
    `JWT_PUBLIC_KEY=${booking.JWT_PUBLIC_KEY}\nAUTH_DEV_PRIVATE_KEY=\n`,
  )

  await assert.rejects(
    async () => prepareDevVars(root),
    /booking.*both empty or both set|local RSA settings/i,
  )
})

test('fails closed when configured services contain more than one valid RSA pair', async (t) => {
  const root = freshFixture(t, 'prepare-dev-vars-mixed-pairs-')
  const otherRoot = freshFixture(t, 'prepare-dev-vars-other-pair-')
  await prepareDevVars(root)
  await prepareDevVars(otherRoot)
  const otherAdmin = envValues(join(otherRoot, 'services/admin/.dev.vars'))
  writeFixture(
    root,
    'services/booking/.dev.vars',
    `JWT_PUBLIC_KEY=${otherAdmin.JWT_PUBLIC_KEY}\nAUTH_DEV_PRIVATE_KEY=${otherAdmin.JWT_PRIVATE_KEY}\n`,
  )

  await assert.rejects(async () => prepareDevVars(root), /booking.*mismatch|local RSA settings/i)
})

test('fails closed when every catalog RSA field is non-empty but malformed', async (t) => {
  const root = freshFixture(t, 'prepare-dev-vars-malformed-')
  writeFixture(
    root,
    'services/admin/.dev.vars',
    'JWT_PRIVATE_KEY=not-a-key\nJWT_PUBLIC_KEY=not-a-key\nAUTH_DEV_PRIVATE_KEY=not-a-key\n',
  )
  for (const directory of domains) {
    writeFixture(
      root,
      `services/${directory}/.dev.vars`,
      'JWT_PUBLIC_KEY=not-a-key\nAUTH_DEV_PRIVATE_KEY=not-a-key\n',
    )
  }

  await assert.rejects(async () => prepareDevVars(root), /malformed|RSA key pair/)
})

test('rejects a symlinked example discovered through the validated catalog', async (t) => {
  const root = freshFixture(t, 'prepare-dev-vars-example-link-')
  const examplePath = join(root, 'services/booking/.dev.vars.example')
  const outside = join(root, 'outside-booking-example')
  writeFileSync(outside, 'JWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\n')
  rmSync(examplePath)
  symlinkSync(outside, examplePath)

  await assert.rejects(async () => prepareDevVars(root), /symbolic link|regular file/i)
})

test('rejects a symlinked dev-vars target discovered through the validated catalog', async (t) => {
  const root = freshFixture(t, 'prepare-dev-vars-target-link-')
  const targetPath = join(root, 'services/example_tauri_service/.dev.vars')
  const outside = join(root, 'outside-tauri-vars')
  writeFileSync(outside, 'JWT_PUBLIC_KEY=\nAUTH_DEV_PRIVATE_KEY=\n')
  symlinkSync(outside, targetPath)

  await assert.rejects(async () => prepareDevVars(root), /symbolic link|regular file/i)
})
