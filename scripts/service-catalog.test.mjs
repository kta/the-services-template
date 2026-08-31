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

function reviewedNativePackageScripts() {
  return {
    'build:tauri': 'node ../../scripts/native-workflow.mjs package build',
    tauri: 'node ../../scripts/native-workflow.mjs package tauri',
  }
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
        `${JSON.stringify({
          name: service.package,
          ...(service.native ? { scripts: reviewedNativePackageScripts() } : {}),
        })}\n`,
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

async function withRepositoryFixture({ services = [], workerOnlyServices = [] }, check) {
  const root = await mkdtemp(join(tmpdir(), 'service-repository-'))
  try {
    await writeFixture(
      root,
      'service-catalog.json',
      `${JSON.stringify({ services, workerOnlyServices })}\n`,
    )
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await mkdir(join(root, 'services'), { recursive: true })
    for (const service of [...services, ...workerOnlyServices]) {
      if (
        !service ||
        typeof service !== 'object' ||
        typeof service.directory !== 'string' ||
        !/^[a-z][a-z0-9_]*$/.test(service.directory)
      )
        continue
      await writeFixture(
        root,
        `services/${service.directory}/package.json`,
        `${JSON.stringify({
          name: service.package,
          ...(Object.hasOwn(service, 'templateKind')
            ? {}
            : { scripts: { build: 'wrangler deploy --dry-run', test: 'vitest run' } }),
        })}\n`,
      )
      if (Object.hasOwn(service, 'templateKind')) {
        await writeFixture(root, `services/${service.directory}/src/web/App.tsx`, 'export {}\n')
      } else {
        await writeFixture(
          root,
          `services/${service.directory}/wrangler.jsonc`,
          '{\n  // Worker-only entrypoint\n  "main": "src/index.ts"\n}\n',
        )
        await writeFixture(root, `services/${service.directory}/src/index.ts`, 'export {}\n')
      }
    }
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function validNativeWorkflow(service) {
  const trustedNode = '$' + '{{ steps.trusted-node.outputs.path }}'
  const artifactPrefix = service.directory.replaceAll('_', '-')
  return `name: ${service.directory} native artifacts
on:\n  workflow_dispatch: {}
permissions:\n  contents: read
env:\n  NODE_VERSION: 22\n  ANDROID_PLATFORM_API: 35\n  ANDROID_NDK_VERSION: 27.2.12479018\n  XCODEGEN_VERSION: 2.46.0
jobs:\n  macos-universal:\n    name: ${service.directory} macOS universal app bundle\n    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.ref_protected == true\n    runs-on: macos-15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: pnpm
      - name: Capture trusted absolute Node path
        id: trusted-node
        shell: bash
        run: |
          set -euo pipefail
          node_path="$(node -p 'require("node:fs").realpathSync(process.execPath)')"
          case "$node_path" in
            /*) ;;
            *) echo "Node did not resolve to an absolute path" >&2; exit 1 ;;
          esac
          test -x "$node_path"
          case "$node_path" in
            "$GITHUB_WORKSPACE"/*) echo "Node resolved inside the checkout" >&2; exit 1 ;;
          esac
          printf 'path=%s\\n' "$node_path" >> "$GITHUB_OUTPUT"
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Check native security boundary
        run: ${trustedNode} scripts/native-workflow.mjs ${service.directory} boundary
      - name: Check pinned Rust toolchain
        run: test "$(rustc --version | awk '{print $2}')" = "1.88.0"
      - name: Check unsigned desktop release boundary
        run: ${trustedNode} scripts/native-workflow.mjs ${service.directory} check-release
      - name: Install universal Rust targets
        run: rustup target add aarch64-apple-darwin x86_64-apple-darwin
      - name: Check Apple build tools
        run: |
          xcodebuild -version
          pod --version
      - name: Build unsigned universal debug app
        run: ${trustedNode} scripts/native-workflow.mjs ${service.directory} build-macos
      - name: Scan macOS artifact for secrets
        run: ${trustedNode} scripts/native-workflow.mjs ${service.directory} verify-macos
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: ${artifactPrefix}-macos-universal-debug
          path: services/${service.directory}/src-tauri/target/universal-apple-darwin/debug/bundle/macos/*.app
          if-no-files-found: error
          retention-days: 7
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

test('allows production selection only for catalog entries with deployable true', () => {
  for (const service of ['admin', 'notifier', 'ops']) {
    const result = runCatalog(['require-deployable', service])
    assert.equal(result.status, 0, result.stderr)
  }
  for (const service of ['example_service', 'example_tauri_service']) {
    const result = runCatalog(['require-deployable', service])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(`${service}.*deployable false`, 'i'))
  }
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
    await writeFixture(
      root,
      '.github/workflows/orphan-build-tauri.yml',
      'on: {workflow_dispatch: {}}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/native-workflow.mjs orphan build-macos\n',
    )
    await writeFixture(
      root,
      '.github/workflows/orphan-dynamic-native.yml',
      'on: {push: {}}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - env: {ACTION: build-macos}\n        run: node scripts/native-workflow.mjs orphan "$ACTION"\n',
    )
    await writeFixture(
      root,
      '.github/workflows/printed-native-text.yml',
      "on: {workflow_dispatch: {}}\njobs:\n  print:\n    runs-on: ubuntu-latest\n    steps:\n      - run: printf '%s\\n' 'build:tauri'\n",
    )
    await writeFixture(
      root,
      '.github/workflows/orphan-indirect-native.yml',
      'on: {push: {}}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - env: {SCRIPT: "build:tauri"}\n        run: pnpm --filter @app/booking run "$SCRIPT"\n',
    )
    await writeFixture(
      root,
      '.github/workflows/orphan-unset-actions.yml',
      `on: {pull_request: {}}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - env: {SCOPE: '@app', SERVICE: booking, SCRIPT: 'build:tauri'}
        run: env -u GITHUB_ACTIONS pnpm --filter "$SCOPE/$SERVICE" run "$SCRIPT"
`,
    )
    await writeFixture(
      root,
      '.github/workflows/orphan-false-actions.yml',
      `on: {push: {}}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: GITHUB_ACTIONS=false pnpm --filter @app/booking run build:tauri
`,
    )
    await writeFixture(
      root,
      '.github/workflows/orphan-raw-tauri.yml',
      `on: {push: {}}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - env: {SCOPE: '@app', SERVICE: booking, CLI: tauri}
        run: pnpm --filter "$SCOPE/$SERVICE" exec "$CLI" build
`,
    )
    await writeFixture(
      root,
      '.github/workflows/orphan-bin-tauri.yml',
      `on: {push: {}}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - env: {BIN_ROOT: node_modules/.bin/, CLI: tauri}
        run: '"$BIN_ROOT$CLI" build'
`,
    )
    await writeFixture(
      root,
      '.github/workflows/orphan-forged-wrapper.yml',
      `on: {pull_request: {}}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - env:
          WRAPPER_ROOT: scripts/native-
          WRAPPER_FILE: workflow.mjs
          TARGET: booking
          NATIVE_ACTION: build-macos
        run: env GITHUB_ACTIONS=true GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF=refs/heads/main GITHUB_REF_PROTECTED=true node "$WRAPPER_ROOT$WRAPPER_FILE" "$TARGET" "$NATIVE_ACTION"
`,
    )
    await writeFixture(
      root,
      '.github/workflows/orphan-with-native.yml',
      `on: {push: {}}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/run-command@1111111111111111111111111111111111111111
        env: {SCOPE: '@app', SERVICE: booking}
        with:
          command: pnpm
          arguments: --filter "$SCOPE/$SERVICE" exec tauri build
`,
    )
    try {
      const result = await validateServiceCatalog(root)
      const diagnostic = result.violations.join('\n')
      assert.match(diagnostic, /booking\.yml.*symbolic link/i)
      assert.match(diagnostic, /orphan\.yml.*not registered.*nativeWorkflow/i)
      assert.match(diagnostic, /orphan-build-tauri\.yml.*not registered.*nativeWorkflow/i)
      assert.match(diagnostic, /orphan-dynamic-native\.yml.*not registered.*nativeWorkflow/i)
      assert.match(diagnostic, /orphan-indirect-native\.yml.*not registered.*nativeWorkflow/i)
      for (const workflow of [
        'orphan-unset-actions',
        'orphan-false-actions',
        'orphan-raw-tauri',
        'orphan-bin-tauri',
        'orphan-forged-wrapper',
        'orphan-with-native',
      ]) {
        assert.match(
          diagnostic,
          new RegExp(`${workflow}\\.yml.*not registered.*nativeWorkflow`, 'i'),
          workflow,
        )
      }
      assert.doesNotMatch(diagnostic, /printed-native-text\.yml.*not registered.*nativeWorkflow/i)
      assert.doesNotMatch(diagnostic, /OUTSIDE_WORKFLOW_SENTINEL/)
    } finally {
      await rm(outside, { force: true })
    }
  })
})

test('validates exact native package entry scripts for every catalog native service', async () => {
  const services = ['booking', 'billing', 'shipping'].map((directory) => ({
    directory,
    package: `@app/${directory}`,
    templateKind: 'tauri',
    deployable: false,
    native: true,
    nativeWorkflow: `.github/workflows/${directory}.yml`,
  }))
  await withCatalogFixture(services, services, async (root) => {
    const mutations = [
      {
        name: 'raw tauri binary',
        scripts: { ...reviewedNativePackageScripts(), tauri: 'tauri' },
      },
      {
        name: 'raw node_modules binary',
        scripts: {
          ...reviewedNativePackageScripts(),
          tauri: 'node_modules/.bin/tauri',
        },
      },
      {
        name: 'semicolon fallback',
        scripts: {
          ...reviewedNativePackageScripts(),
          tauri: 'node ../../scripts/native-workflow.mjs package tauri; tauri',
        },
      },
      {
        name: 'or fallback',
        scripts: {
          ...reviewedNativePackageScripts(),
          tauri: 'node ../../scripts/native-workflow.mjs package tauri || tauri',
        },
      },
      {
        name: 'guard prefix fallback',
        scripts: {
          ...reviewedNativePackageScripts(),
          'build:tauri':
            'node ../../scripts/native-workflow.mjs package-guard && false || tauri build',
        },
      },
    ]

    for (const mutation of mutations) {
      await writeFixture(
        root,
        'services/shipping/package.json',
        `${JSON.stringify({ name: '@app/shipping', scripts: mutation.scripts })}\n`,
      )
      const diagnostic = (await validateServiceCatalog(root)).violations.join('\n')
      assert.match(
        diagnostic,
        /shipping.*native package script.*exact reviewed wrapper/i,
        mutation.name,
      )
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
    assert.match(diagnostic, /booking\.yml.*exact native wrapper sequence/i)
    assert.match(diagnostic, /booking\.yml.*ANDROID_PLATFORM_API/i)
  })

  await withCatalogFixture([service], [service], async (root) => {
    await writeFixture(
      root,
      service.nativeWorkflow,
      `${validNativeWorkflow(service).replace('  workflow_dispatch: {}', '  workflow_dispatch: {}\n  push:\n    branches: [main]')}  unprotected:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo unsafe\n`,
    )
    const diagnostic = (await validateServiceCatalog(root)).violations.join('\n')
    assert.match(diagnostic, /booking\.yml.*only workflow_dispatch/i)
    assert.match(diagnostic, /booking\.yml.*unprotected.*exact protected main predicate/i)
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

test('returns normalized worker-only objects and classifies every service directory exactly once', async () => {
  const worker = { directory: 'metrics', package: '@app/metrics', deployable: true }
  await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
    const result = await validateServiceCatalog(root)
    assert.deepEqual(result.violations, [])
    assert.deepEqual(result.workerOnlyServices, [worker])

    await writeFixture(root, 'services/unknown/package.json', '{"name":"@app/unknown"}\n')
    await writeFixture(root, 'services/unknown/src/index.ts', 'export {}\n')
    const unknown = await validateServiceCatalog(root)
    assert.match(unknown.violations.join('\n'), /unknown.*missing from service-catalog\.json/i)
  })
})

test('rejects missing, malformed, symlinked, and web worker-only package identities', async () => {
  const worker = { directory: 'metrics', package: '@app/metrics', deployable: true }
  await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
    await writeFixture(root, 'services/metrics/package.json', '{"name":"@app/wrong"}\n')
    await writeFixture(root, 'services/metrics/src/web/App.tsx', 'export {}\n')
    const result = await validateServiceCatalog(root)
    const diagnostic = result.violations.join('\n')
    assert.match(diagnostic, /metrics.*package.*does not match/i)
    assert.match(diagnostic, /metrics.*worker-only.*src\/web/i)
    assert.deepEqual(result.workerOnlyServices, [])
  })

  await withRepositoryFixture(
    { workerOnlyServices: [{ directory: 'ghost', package: '@app/ghost', deployable: false }] },
    async (root) => {
      await rm(join(root, 'services/ghost'), { recursive: true, force: true })
      const result = await validateServiceCatalog(root)
      assert.match(result.violations.join('\n'), /services\/ghost.*missing/i)
    },
  )

  await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
    const outside = join(root, '..', `worker-package-${process.pid}.json`)
    await writeFile(outside, '{"name":"@app/metrics","sentinel":"OUTSIDE_WORKER_SENTINEL"}\n')
    await rm(join(root, 'services/metrics/package.json'))
    await symlink(outside, join(root, 'services/metrics/package.json'))
    try {
      const result = await validateServiceCatalog(root)
      assert.match(result.violations.join('\n'), /metrics\/package\.json.*symbolic link/i)
      assert.doesNotMatch(result.violations.join('\n'), /OUTSIDE_WORKER_SENTINEL/)
    } finally {
      await rm(outside, { force: true })
    }
  })
})

test('rejects worker-only schema drift before returning entries', async () => {
  await withRepositoryFixture(
    {
      workerOnlyServices: [
        'notifier',
        { directory: '../../outside', package: '@app/outside', deployable: true },
        { directory: 'metrics', package: '@app/wrong', deployable: 'yes' },
      ],
    },
    async (root) => {
      const result = await validateServiceCatalog(root)
      assert.deepEqual(result.workerOnlyServices, [])
      const diagnostic = result.violations.join('\n')
      assert.match(diagnostic, /workerOnlyServices\[0\].*object/i)
      assert.match(diagnostic, /workerOnlyServices\[1\].*invalid directory/i)
      assert.match(diagnostic, /metrics.*package must be exactly @app\/metrics/i)
      assert.match(diagnostic, /metrics.*deployable must be boolean/i)
    },
  )
})

test('requires every service package.json to be a non-array object with the exact name', async () => {
  const worker = { directory: 'metrics', package: '@app/metrics', deployable: true }
  for (const value of [null, false, 0, '', [], {}]) {
    await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
      await writeFixture(root, 'services/metrics/package.json', `${JSON.stringify(value)}\n`)
      const result = await validateServiceCatalog(root)
      assert.deepEqual(result.workerOnlyServices, [])
      const diagnostic = result.violations.join('\n')
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        assert.match(diagnostic, /metrics\/package\.json.*non-array object/i)
      } else {
        assert.match(diagnostic, /metrics.*package\.json name must be exactly @app\/metrics/i)
      }
    })
  }

  const spa = {
    directory: 'booking',
    package: '@app/booking',
    templateKind: 'web',
    deployable: false,
    native: false,
  }
  await withCatalogFixture([spa], [spa], async (root) => {
    await writeFixture(root, 'services/booking/package.json', 'false\n')
    const result = await validateServiceCatalog(root)
    assert.deepEqual(result.services, [])
    assert.match(result.violations.join('\n'), /booking\/package\.json.*non-array object/i)
  })
})

test('requires worker-only Wrangler JSONC, contained regular main, and build/test scripts', async () => {
  const worker = { directory: 'metrics', package: '@app/metrics', deployable: true }

  await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
    await writeFixture(root, 'services/metrics/wrangler.jsonc', '{ invalid jsonc\n')
    const result = await validateServiceCatalog(root)
    assert.deepEqual(result.workerOnlyServices, [])
    assert.match(result.violations.join('\n'), /metrics\/wrangler\.jsonc.*invalid JSONC/i)
  })

  await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
    await writeFixture(root, 'services/metrics/wrangler.jsonc', '{"main":"../../outside.ts"}\n')
    await writeFixture(root, 'outside.ts', 'WORKER_MAIN_OUTSIDE_SENTINEL\n')
    const result = await validateServiceCatalog(root)
    assert.deepEqual(result.workerOnlyServices, [])
    const diagnostic = result.violations.join('\n')
    assert.match(diagnostic, /metrics.*main.*outside/i)
    assert.doesNotMatch(diagnostic, /WORKER_MAIN_OUTSIDE_SENTINEL/)
  })

  await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
    const outside = join(root, '..', `worker-main-${process.pid}.ts`)
    await writeFile(outside, 'WORKER_MAIN_SYMLINK_SENTINEL\n')
    await rm(join(root, 'services/metrics/src/index.ts'))
    await symlink(outside, join(root, 'services/metrics/src/index.ts'))
    try {
      const result = await validateServiceCatalog(root)
      assert.deepEqual(result.workerOnlyServices, [])
      const diagnostic = result.violations.join('\n')
      assert.match(diagnostic, /metrics.*main.*symbolic link/i)
      assert.doesNotMatch(diagnostic, /WORKER_MAIN_SYMLINK_SENTINEL/)
    } finally {
      await rm(outside, { force: true })
    }
  })

  await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
    await writeFixture(
      root,
      'services/metrics/package.json',
      '{"name":"@app/metrics","scripts":{"build":"","test":false}}\n',
    )
    const result = await validateServiceCatalog(root)
    assert.deepEqual(result.workerOnlyServices, [])
    const diagnostic = result.violations.join('\n')
    assert.match(diagnostic, /metrics.*scripts\.build.*non-empty string/i)
    assert.match(diagnostic, /metrics.*scripts\.test.*non-empty string/i)
  })
})

test('rejects a package-only worker directory with no Wrangler config or source entry', async () => {
  const worker = { directory: 'metrics', package: '@app/metrics', deployable: true }
  await withRepositoryFixture({ workerOnlyServices: [worker] }, async (root) => {
    await rm(join(root, 'services/metrics/wrangler.jsonc'))
    await rm(join(root, 'services/metrics/src'), { recursive: true, force: true })
    const result = await validateServiceCatalog(root)
    assert.deepEqual(result.workerOnlyServices, [])
    assert.match(result.violations.join('\n'), /metrics\/wrangler\.jsonc.*missing/i)
  })
})
