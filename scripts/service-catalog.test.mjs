import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateServiceCatalog } from './service-catalog.mjs'

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
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await mkdir(join(root, 'services'), { recursive: true })
    for (const service of catalog) {
      await writeFixture(
        root,
        `services/${service.directory}/package.json`,
        `${JSON.stringify({ name: service.package })}\n`,
      )
      await writeFixture(root, `services/${service.directory}/src/web/App.tsx`, 'export {}\n')
      if (service.native && typeof service.nativeWorkflow === 'string') {
        await writeFixture(root, service.nativeWorkflow, validNativeWorkflow(service))
      }
    }
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function validNativeWorkflow(service) {
  return `name: ${service.directory} native artifacts
on:\n  workflow_dispatch: {}
env:\n  ANDROID_PLATFORM_API: 35\n  ANDROID_NDK_VERSION: 27.2.12479018\n  XCODEGEN_VERSION: 2.46.0
jobs:\n  build:\n    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.ref_protected == true\n    runs-on: ubuntu-latest
    steps:\n      - run: node scripts/check-tauri-boundary.mjs
      - run: pnpm --filter ${service.package} build:tauri
      - run: node scripts/check-tauri-artifact.mjs services/${service.directory}/src-tauri/target
`
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
    assert.match(result.stderr, /booking.*package must be exactly @app\/booking/i)
    assert.match(result.stderr, /booking.*templateKind web.*native false/i)
  })
})

test('rejects unsafe, missing, duplicate, and non-native workflow registrations', async () => {
  const booking = {
    directory: 'booking',
    package: '@app/booking',
    templateKind: 'tauri',
    deployable: false,
    native: true,
    nativeWorkflow: '../outside.yml',
  }
  await withCatalogFixture([], [booking], async (root) => {
    const result = await validateServiceCatalog(root)
    assert.match(
      result.violations.join('\n'),
      /booking.*nativeWorkflow.*\.github\/workflows.*\.ya?ml/i,
    )
  })

  const web = {
    directory: 'booking',
    package: '@app/booking',
    templateKind: 'web',
    deployable: false,
    native: false,
    nativeWorkflow: '.github/workflows/booking.yml',
  }
  await withCatalogFixture([web], [web], async (root) => {
    const result = await validateServiceCatalog(root)
    assert.match(result.violations.join('\n'), /booking.*non-native.*nativeWorkflow/i)
  })

  const first = { ...booking, nativeWorkflow: '.github/workflows/native.yml' }
  const second = {
    ...first,
    directory: 'billing',
    package: '@app/billing',
  }
  await withCatalogFixture([first, second], [first, second], async (root) => {
    const result = await validateServiceCatalog(root)
    assert.match(result.violations.join('\n'), /duplicate nativeWorkflow/i)
  })

  const missing = { ...booking, nativeWorkflow: '.github/workflows/missing.yml' }
  await withCatalogFixture([missing], [missing], async (root) => {
    await rm(join(root, missing.nativeWorkflow))
    const result = await validateServiceCatalog(root)
    assert.match(result.violations.join('\n'), /missing\.yml.*missing/i)
  })

  const nonRegular = { ...booking, nativeWorkflow: '.github/workflows/directory.yml' }
  await withCatalogFixture([nonRegular], [nonRegular], async (root) => {
    await rm(join(root, nonRegular.nativeWorkflow))
    await mkdir(join(root, nonRegular.nativeWorkflow))
    const result = await validateServiceCatalog(root)
    assert.match(result.violations.join('\n'), /directory\.yml.*regular file/i)
  })
})

test('rejects workflow symlinks and orphan native workflows without reading outside', async () => {
  const service = {
    directory: 'booking',
    package: '@app/booking',
    templateKind: 'tauri',
    deployable: false,
    native: true,
    nativeWorkflow: '.github/workflows/booking.yml',
  }
  await withCatalogFixture([service], [service], async (root) => {
    const outside = join(root, '..', `outside-native-${process.pid}.yml`)
    await writeFile(outside, 'OUTSIDE_WORKFLOW_SENTINEL')
    await rm(join(root, service.nativeWorkflow))
    await symlink(outside, join(root, service.nativeWorkflow))
    await writeFixture(
      root,
      '.github/workflows/orphan.yml',
      validNativeWorkflow({
        ...service,
        directory: 'orphan',
        package: '@app/orphan',
      }),
    )
    try {
      const result = await validateServiceCatalog(root)
      const diagnostic = result.violations.join('\n')
      assert.match(diagnostic, /booking\.yml.*symbolic link/i)
      assert.match(diagnostic, /orphan\.yml.*not registered.*nativeWorkflow/i)
      assert.doesNotMatch(diagnostic, /OUTSIDE_WORKFLOW_SENTINEL/)
    } finally {
      await rm(outside, { force: true })
    }
  })
})

test('applies native workflow security policy to every catalog workflow', async () => {
  const service = {
    directory: 'booking',
    package: '@app/booking',
    templateKind: 'tauri',
    deployable: false,
    native: true,
    nativeWorkflow: '.github/workflows/booking.yml',
  }
  await withCatalogFixture([service], [service], async (root) => {
    await writeFixture(
      root,
      service.nativeWorkflow,
      `name: unsafe\non:\n  push: {}\njobs:\n  build:\n    steps:\n      - run: wrangler deploy\n    env:\n      CLOUDFLARE_API_TOKEN: secret\n`,
    )
    const diagnostic = (await validateServiceCatalog(root)).violations.join('\n')
    assert.match(diagnostic, /booking\.yml.*workflow_dispatch/i)
    assert.match(diagnostic, /booking\.yml.*protected main/i)
    assert.match(diagnostic, /booking\.yml.*Cloudflare credential/i)
    assert.match(diagnostic, /booking\.yml.*boundary checker/i)
    assert.match(diagnostic, /booking\.yml.*artifact checker/i)
    assert.match(diagnostic, /booking\.yml.*ANDROID_PLATFORM_API/i)
  })

  await withCatalogFixture([service], [service], async (root) => {
    await writeFixture(
      root,
      service.nativeWorkflow,
      `${validNativeWorkflow(service).replace('  workflow_dispatch: {}', '  workflow_dispatch: {}\n  push:\n    branches: [main]')}  unprotected:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo unsafe\n`,
    )
    const diagnostic = (await validateServiceCatalog(root)).violations.join('\n')
    assert.match(diagnostic, /booking\.yml.*manual-only.*push/i)
    assert.match(diagnostic, /booking\.yml.*every native workflow job.*protected main/i)
  })
})

test('returns only normalized entries and never consumes invalid catalog values', async () => {
  const invalidServices = [
    null,
    {
      directory: '../../outside',
      package: '@app/outside',
      templateKind: 'tauri',
      deployable: false,
      native: true,
    },
    {
      directory: 'booking',
      package: '@app/booking',
      templateKind: 'tauri',
      deployable: false,
      native: 'yes',
    },
  ]
  await withCatalogFixture([], invalidServices, async (root) => {
    await mkdir(join(root, 'services'), { recursive: true })
    const sentinel = join(root, '..', 'outside', 'package.json')
    await mkdir(join(sentinel, '..'), { recursive: true })
    await writeFile(sentinel, 'WORKSPACE_OUTSIDE_SENTINEL')
    try {
      const result = await validateServiceCatalog(root)
      assert.deepEqual(result.services, [])
      assert.match(result.violations.join('\n'), /services\[0\].*object/)
      assert.match(result.violations.join('\n'), /invalid directory.*\.\.\/\.\.\/outside/)
      assert.match(result.violations.join('\n'), /booking.*native must be boolean/)
      assert.doesNotMatch(result.violations.join('\n'), /WORKSPACE_OUTSIDE_SENTINEL/)
    } finally {
      await rm(join(root, '..', 'outside'), { recursive: true, force: true })
    }
  })

  await withCatalogFixture([], [], async (root) => {
    await writeFixture(root, 'service-catalog.json', 'null\n')
    const result = await validateServiceCatalog(root)
    assert.deepEqual(result.services, [])
    assert.match(result.violations.join('\n'), /service-catalog\.json must contain an object/i)
  })
})

test('rejects service roots and unknown service directories that are symbolic links', async () => {
  const service = {
    directory: 'booking',
    package: '@app/booking',
    templateKind: 'web',
    deployable: false,
    native: false,
  }
  await withCatalogFixture([], [service], async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'service-catalog-outside-'))
    await writeFixture(outside, 'package.json', '{"name":"@app/booking"}\n')
    await writeFixture(outside, 'src/web/App.tsx', 'OUTSIDE_SERVICE_SENTINEL\n')
    await mkdir(join(root, 'services'), { recursive: true })
    await symlink(outside, join(root, 'services/booking'), 'dir')
    await symlink(outside, join(root, 'services/unknown'), 'dir')
    try {
      const result = await validateServiceCatalog(root)
      assert.deepEqual(result.services, [])
      assert.match(result.violations.join('\n'), /services\/booking.*symbolic link/)
      assert.match(result.violations.join('\n'), /services\/unknown.*symbolic link/)
      assert.doesNotMatch(result.violations.join('\n'), /OUTSIDE_SERVICE_SENTINEL/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('rejects a symbolic services parent without reading the external tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'service-catalog-parent-'))
  const outside = await mkdtemp(join(tmpdir(), 'service-catalog-parent-outside-'))
  try {
    await writeFixture(root, 'service-catalog.json', '{"services":[]}\n')
    await writeFixture(outside, 'unknown/src/web/App.tsx', 'PARENT_OUTSIDE_SENTINEL\n')
    await symlink(outside, join(root, 'services'), 'dir')
    const result = await validateServiceCatalog(root)
    assert.deepEqual(result.services, [])
    assert.match(result.violations.join('\n'), /services.*symbolic link/)
    assert.doesNotMatch(result.violations.join('\n'), /PARENT_OUTSIDE_SENTINEL/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
