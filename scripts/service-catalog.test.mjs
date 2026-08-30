import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const catalogCli = join(process.cwd(), 'scripts/service-catalog.mjs')

function runCatalog(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [catalogCli, ...args], { cwd, encoding: 'utf8' })
}

async function writeFixture(root, path, content) {
  const destination = join(root, path)
  await mkdir(join(destination, '..'), { recursive: true })
  await writeFile(destination, content)
}

async function withCatalogFixture(catalog, services, check) {
  const root = await mkdtemp(join(tmpdir(), 'service-catalog-'))
  try {
    await writeFixture(root, 'service-catalog.json', `${JSON.stringify({ services })}\n`)
    for (const service of catalog) {
      await writeFixture(
        root,
        `services/${service.directory}/package.json`,
        `${JSON.stringify({ name: service.package })}\n`,
      )
      await writeFixture(root, `services/${service.directory}/src/web/App.tsx`, 'export {}\n')
    }
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('lists the current SPA service catalog and native manifests as JSON', () => {
  const catalogResult = runCatalog(['list', '--json'])
  assert.equal(catalogResult.status, 0, catalogResult.stderr)
  const services = JSON.parse(catalogResult.stdout)
  assert.deepEqual(
    services.map(({ directory, package: packageName, templateKind, deployable, native }) => ({
      directory,
      package: packageName,
      templateKind,
      deployable,
      native,
    })),
    [
      {
        directory: 'admin',
        package: '@app/admin',
        templateKind: 'tauri',
        deployable: true,
        native: true,
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
      },
    ],
  )

  const manifestsResult = runCatalog(['native-manifests', '--json'])
  assert.equal(manifestsResult.status, 0, manifestsResult.stderr)
  assert.deepEqual(JSON.parse(manifestsResult.stdout), [
    'services/admin/src-tauri/Cargo.toml',
    'services/example_tauri_service/src-tauri/Cargo.toml',
  ])
})

test('allows native commands only for catalog services classified as Tauri', () => {
  for (const service of ['admin', 'example_tauri_service']) {
    const result = runCatalog(['require-native', service])
    assert.equal(result.status, 0, result.stderr)
  }
  const webResult = runCatalog(['require-native', 'example_service'])
  assert.notEqual(webResult.status, 0)
  assert.match(webResult.stderr, /example_service.*Web-only.*native/i)
})

test('rejects an SPA workspace that is missing from the catalog', async () => {
  const registered = {
    directory: 'example_service',
    package: '@app/example_service',
    templateKind: 'web',
    deployable: false,
    native: false,
  }
  await withCatalogFixture([registered], [registered], async (root) => {
    await writeFixture(root, 'services/booking/package.json', '{"name":"@app/booking"}\n')
    await writeFixture(root, 'services/booking/src/web/App.tsx', 'export {}\n')
    const result = runCatalog(['validate', '--root', root])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /booking.*missing from service-catalog\.json/i)
  })
})

test('rejects catalog package drift and an invalid native classification', async () => {
  const wrong = {
    directory: 'booking',
    package: '@app/wrong',
    templateKind: 'web',
    deployable: true,
    native: true,
  }
  await withCatalogFixture([wrong], [wrong], async (root) => {
    await writeFixture(root, 'services/booking/package.json', '{"name":"@app/booking"}\n')
    const result = runCatalog(['validate', '--root', root])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /booking.*package.*@app\/wrong.*@app\/booking/i)
    assert.match(result.stderr, /booking.*templateKind web.*native false/i)
  })
})
