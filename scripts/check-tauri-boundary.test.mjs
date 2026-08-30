import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateTauriBoundary } from './check-tauri-boundary.mjs'

async function withFixture(files, check) {
  const root = await mkdtemp(join(tmpdir(), 'tauri-boundary-'))
  try {
    await Promise.all(
      Object.entries(files).map(async ([file, content]) => {
        const path = join(root, file)
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, content)
      }),
    )
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const cleanConfig = JSON.stringify({
  app: {
    windows: [{ label: 'main', title: 'Test' }],
    security: {
      capabilities: ['default'],
      csp: {
        'default-src': "'self'",
        'base-uri': "'self'",
        'form-action': "'self'",
        'object-src': "'none'",
        'script-src': "'self'",
        'style-src': "'self'",
        'img-src': "'self' data:",
        'font-src': "'self'",
        'connect-src': "'self' ipc: http://ipc.localhost",
      },
      devCsp: {
        'default-src': "'self'",
        'base-uri': "'self'",
        'form-action': "'self'",
        'object-src': "'none'",
        'script-src': "'self'",
        'style-src': "'self' 'unsafe-inline'",
        'img-src': "'self' data:",
        'font-src': "'self'",
        'connect-src':
          "'self' ipc: http://ipc.localhost http://localhost:5174 ws://localhost:5174 ws://127.0.0.1:5174 ws://localhost:1421 ws://127.0.0.1:1421",
      },
    },
  },
})
const cleanConfigValue = (name) => JSON.parse(cleanConfig).app.security[name]
const exampleTauriCleanConfig = cleanConfig
  .replaceAll('localhost:5174', 'localhost:5175')
  .replaceAll('127.0.0.1:5174', '127.0.0.1:5175')
const cleanCapability = JSON.stringify({
  identifier: 'default',
  windows: ['main'],
  permissions: ['allow-api-request'],
})
const adminCleanCapability = JSON.stringify({
  identifier: 'default',
  windows: ['main'],
  permissions: ['allow-api-request', 'allow-clear-session'],
})
const adminNavigationGuard = [
  'mod origin;',
  'tauri::Builder::default()',
  '  .plugin(',
  '    tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")',
  '      .on_navigation(|_, url| {',
  '        origin::navigation_allowed(url, env!("TAURI_ADMIN_API_ORIGIN"))',
  '      })',
  '      .build(),',
  '  )',
].join('\n')
const exampleTauriNavigationGuard = adminNavigationGuard.replaceAll(
  'TAURI_ADMIN_API_ORIGIN',
  'TAURI_EXAMPLE_TAURI_SERVICE_API_ORIGIN',
)

const nativeTransport = [
  "import { invoke } from '@tauri-apps/api/core'",
  '',
  'export async function platformFetch(path: string) {',
  "  return invoke('api_request', { path })",
  '}',
].join('\n')
const fixedReleaseOrigin = [
  'const APPROVED_RELEASE_ORIGINS: [&str; 1] = ["https://example.example.com"];',
  '',
  'pub fn parse(raw: &str, release: bool) -> Result<String, String> {',
  '    if release && !APPROVED_RELEASE_ORIGINS.contains(&raw) {',
  '        return Err("release API origin is not approved".to_owned());',
  '    }',
  '    Ok(raw.to_owned())',
  '}',
].join('\n')
const platformOverlays = {
  'services/example_tauri_service/src-tauri/tauri.android.conf.json': JSON.stringify({
    bundle: { android: { minSdkVersion: 24 } },
  }),
  'services/example_tauri_service/src-tauri/tauri.ios.conf.json': JSON.stringify({
    bundle: { iOS: { minimumSystemVersion: '14.0' } },
  }),
  'services/example_tauri_service/src-tauri/tauri.macos.conf.json': JSON.stringify({
    bundle: { targets: ['app'], macOS: { minimumSystemVersion: '10.13' } },
  }),
}

function separatedTemplateFiles(extra = {}) {
  return {
    'services/admin/src/web/App.tsx': 'export function App() { return null }\n',
    'services/admin/src-tauri/tauri.conf.json': cleanConfig,
    'services/admin/src-tauri/capabilities/default.json': adminCleanCapability,
    'services/admin/src-tauri/src/lib.rs': adminNavigationGuard,
    'services/example_service/src/web/App.tsx': 'export function App() { return null }\n',
    'services/example_service/package.json': JSON.stringify({
      scripts: { dev: 'vite dev' },
      dependencies: { react: 'catalog:' },
    }),
    'services/example_tauri_service/package.json': JSON.stringify({
      scripts: { tauri: 'tauri' },
      dependencies: { '@tauri-apps/api': 'catalog:' },
      devDependencies: { '@tauri-apps/cli': 'catalog:' },
    }),
    'services/example_tauri_service/src/web/App.tsx': 'export function App() { return null }\n',
    'services/example_tauri_service/src-tauri/Cargo.toml': '[package]\nname = "example"\n',
    'services/example_tauri_service/src-tauri/tauri.conf.json': exampleTauriCleanConfig,
    'services/example_tauri_service/src-tauri/capabilities/default.json': cleanCapability,
    'services/example_tauri_service/src-tauri/src/lib.rs': exampleTauriNavigationGuard,
    'services/example_tauri_service/src-tauri/src/origin.rs': fixedReleaseOrigin,
    'services/example_tauri_service/src/web/platform/transport.ts': nativeTransport,
    ...platformOverlays,
    ...extra,
  }
}

function baseFiles(extra = {}) {
  return separatedTemplateFiles(extra)
}

function assertWebTemplateTauriViolation(violations, category) {
  assert.ok(
    violations.some(
      (violation) =>
        violation.includes('services/example_service') &&
        violation.includes('Tauri') &&
        violation.toLowerCase().includes(category),
    ),
  )
}

function assertTauriTemplateViolation(violations, asset) {
  assert.ok(
    violations.some(
      (violation) =>
        violation.includes('services/example_tauri_service') &&
        violation.includes('Tauri') &&
        violation.toLowerCase().includes('template') &&
        violation.includes(asset),
    ),
  )
}

for (const [asset, category, files] of [
  [
    'src-tauri directory',
    'src-tauri',
    {
      'services/example_service/src-tauri/tauri.conf.json': exampleTauriCleanConfig,
    },
  ],
  [
    '@tauri-apps API dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        dependencies: { '@tauri-apps/api': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps plugin dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        dependencies: { '@tauri-apps/plugin-shell': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps CLI development dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        devDependencies: { '@tauri-apps/cli': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps plugin development dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        devDependencies: { '@tauri-apps/plugin-opener': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps API optional dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        optionalDependencies: { '@tauri-apps/api': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps CLI optional dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        optionalDependencies: { '@tauri-apps/cli': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps plugin optional dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        optionalDependencies: { '@tauri-apps/plugin-fs': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps API peer dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        peerDependencies: { '@tauri-apps/api': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps CLI peer dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        peerDependencies: { '@tauri-apps/cli': 'catalog:' },
      }),
    },
  ],
  [
    '@tauri-apps plugin peer dependency',
    'dependency',
    {
      'services/example_service/package.json': JSON.stringify({
        peerDependencies: { '@tauri-apps/plugin-opener': 'catalog:' },
      }),
    },
  ],
  [
    'tauri package script',
    'script',
    {
      'services/example_service/package.json': JSON.stringify({
        scripts: { tauri: 'tauri' },
      }),
    },
  ],
  [
    'tauri-prefixed package script',
    'script',
    {
      'services/example_service/package.json': JSON.stringify({
        scripts: { 'tauri:android': 'tauri android build' },
      }),
    },
  ],
  [
    'tauri-suffixed package script',
    'script',
    {
      'services/example_service/package.json': JSON.stringify({
        scripts: { 'build:tauri': 'vite --config vite.tauri.config.ts build' },
      }),
    },
  ],
]) {
  test(`rejects ${asset} in the Web-only example template`, async () => {
    await withFixture(separatedTemplateFiles(files), async (root) => {
      const violations = await validateTauriBoundary(root)
      assertWebTemplateTauriViolation(violations, category)
    })
  })
}

for (const [asset, missingPath] of [
  ['Cargo.toml', 'services/example_tauri_service/src-tauri/Cargo.toml'],
  ['tauri.conf.json', 'services/example_tauri_service/src-tauri/tauri.conf.json'],
  [
    'capabilities/default.json',
    'services/example_tauri_service/src-tauri/capabilities/default.json',
  ],
  ['platform/transport.ts', 'services/example_tauri_service/src/web/platform/transport.ts'],
  ['src/origin.rs', 'services/example_tauri_service/src-tauri/src/origin.rs'],
  ['tauri.android.conf.json', 'services/example_tauri_service/src-tauri/tauri.android.conf.json'],
  ['tauri.ios.conf.json', 'services/example_tauri_service/src-tauri/tauri.ios.conf.json'],
  ['tauri.macos.conf.json', 'services/example_tauri_service/src-tauri/tauri.macos.conf.json'],
]) {
  test(`requires ${asset} in the Tauri example template`, async () => {
    const files = separatedTemplateFiles()
    delete files[missingPath]
    await withFixture(files, async (root) => {
      const violations = await validateTauriBoundary(root)
      assertTauriTemplateViolation(violations, asset)
    })
  })
}

test('requires the Tauri template to keep its fixed release origin allowlist', async () => {
  await withFixture(
    separatedTemplateFiles({
      'services/example_tauri_service/src-tauri/src/origin.rs':
        'pub fn parse(raw: &str) -> String { raw.to_owned() }\n',
    }),
    async (root) => {
      assertTauriTemplateViolation(await validateTauriBoundary(root), 'src/origin.rs')
    },
  )
})

test('requires the Tauri template to use the native invoke transport', async () => {
  await withFixture(
    separatedTemplateFiles({
      'services/example_tauri_service/src/web/platform/transport.ts':
        'export const platformFetch = (path) => fetch(path)\n',
    }),
    async (root) => {
      assertTauriTemplateViolation(await validateTauriBoundary(root), 'platform/transport.ts')
    },
  )
})

for (const [name, path, overlay] of [
  [
    'Android minSdkVersion',
    'services/example_tauri_service/src-tauri/tauri.android.conf.json',
    { bundle: { android: {} } },
  ],
  [
    'Android minSdkVersion value',
    'services/example_tauri_service/src-tauri/tauri.android.conf.json',
    { bundle: { android: { minSdkVersion: 25 } } },
  ],
  [
    'iOS minimumSystemVersion',
    'services/example_tauri_service/src-tauri/tauri.ios.conf.json',
    { bundle: { iOS: {} } },
  ],
  [
    'iOS minimumSystemVersion value',
    'services/example_tauri_service/src-tauri/tauri.ios.conf.json',
    { bundle: { iOS: { minimumSystemVersion: '15.0' } } },
  ],
  [
    'macOS app target',
    'services/example_tauri_service/src-tauri/tauri.macos.conf.json',
    { bundle: { macOS: { minimumSystemVersion: '10.13' } } },
  ],
  [
    'macOS app target value',
    'services/example_tauri_service/src-tauri/tauri.macos.conf.json',
    { bundle: { targets: ['dmg'], macOS: { minimumSystemVersion: '10.13' } } },
  ],
  [
    'macOS minimumSystemVersion',
    'services/example_tauri_service/src-tauri/tauri.macos.conf.json',
    { bundle: { targets: ['app'], macOS: {} } },
  ],
  [
    'macOS minimumSystemVersion value',
    'services/example_tauri_service/src-tauri/tauri.macos.conf.json',
    { bundle: { targets: ['app'], macOS: { minimumSystemVersion: '11.0' } } },
  ],
]) {
  test(`requires ${name} in the Tauri template platform overlay`, async () => {
    await withFixture(separatedTemplateFiles({ [path]: JSON.stringify(overlay) }), async (root) => {
      assertTauriTemplateViolation(await validateTauriBoundary(root), path.split('/').at(-1))
    })
  })
}

test('accepts a separated Web and secure Tauri template fixture', async () => {
  await withFixture(separatedTemplateFiles(), async (root) => {
    assert.deepEqual(await validateTauriBoundary(root), [])
  })
})

test('accepts the current safe Tauri boundary', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/platform/transport.ts':
        'export function platformFetch() { return fetch("/api/items") }\n',
      'services/admin/src/web/auth/session.ts': [
        "import { platformFetch } from '../platform/transport'",
        "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
        "const LOGOUT_INTENT_KEY = 'app.admin.logout.intent'",
        'export async function devLogin() {',
        "  const res = await platformFetch('/api/auth/token')",
        '  const { token } = await res.json()',
        '  sessionStorage.setItem(DEV_TOKEN_KEY, token)',
        '}',
        "export function logout() { localStorage.setItem(LOGOUT_INTENT_KEY, '1') }",
      ].join('\n'),
    }),
    async (root) => assert.deepEqual(await validateTauriBoundary(root), []),
  )
})

test('automatically audits a copied Tauri service instead of silently skipping it', async () => {
  const bookingSecurity = JSON.parse(cleanConfig).app.security
  bookingSecurity.devCsp['connect-src'] = bookingSecurity.devCsp['connect-src']
    .replaceAll('5174', '5180')
    .replaceAll('5173', '5180')
  const safeBookingConfig = JSON.stringify({
    build: { devUrl: 'http://localhost:5180' },
    app: {
      windows: [{ label: 'main', title: 'Booking' }],
      security: {
        ...bookingSecurity,
      },
    },
  })
  await withFixture(
    baseFiles({
      'services/booking/src/web/App.tsx': 'export function App() { return null }\n',
      'services/booking/src-tauri/tauri.conf.json': safeBookingConfig,
      'services/booking/src-tauri/capabilities/default.json': cleanCapability,
      'services/booking/src-tauri/src/lib.rs': [
        'mod origin;',
        'tauri::Builder::default()',
        '  .plugin(',
        '    tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")',
        '      .on_navigation(|_, url| {',
        '        origin::navigation_allowed(url, env!("TAURI_BOOKING_API_ORIGIN"))',
        '      })',
        '      .build(),',
        '  )',
      ].join('\n'),
    }),
    async (root) => {
      assert.deepEqual(await validateTauriBoundary(root), [])
    },
  )
})

test('rejects fetch through call', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/ReviewFetchCall.tsx':
        "globalThis.fetch.call(globalThis, '/api/call')\n",
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('raw fetch')))
    },
  )
})

test('allows only generated native app command permissions', async () => {
  const capability = JSON.parse(
    await readFile(
      join(process.cwd(), 'services/admin/src-tauri/capabilities/default.json'),
      'utf8',
    ),
  )
  assert.deepEqual(capability.permissions, ['allow-api-request', 'allow-clear-session'])

  const buildScript = await readFile(
    join(process.cwd(), 'services/admin/src-tauri/build.rs'),
    'utf8',
  )
  assert.match(buildScript, /commands\(&\["api_request", "clear_session"\]\)/)
})

test('rejects remote, extra-window, and webview capability grants', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src-tauri/capabilities/wide.json': JSON.stringify({
        identifier: 'wide',
        windows: ['main', 'settings'],
        webviews: ['main'],
        remote: { urls: ['https://evil.example'] },
        permissions: ['allow-api-request', 'allow-clear-session'],
      }),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('remote capability access')))
      assert.ok(violations.some((violation) => violation.includes('webview capability access')))
      assert.ok(violations.some((violation) => violation.includes('exactly the local main window')))
    },
  )
})

test('rejects remote or non-main Tauri windows', async () => {
  for (const windows of [
    [{ label: 'main', url: 'https://attacker.example' }],
    [{ label: 'main' }, { label: 'settings' }],
    [{ label: 'settings' }],
  ]) {
    await withFixture(
      baseFiles({
        'services/admin/src-tauri/tauri.conf.json': JSON.stringify({
          app: {
            windows,
            security: JSON.parse(cleanConfig).app.security,
          },
        }),
      }),
      async (root) => {
        const violations = await validateTauriBoundary(root)
        assert.ok(violations.some((violation) => violation.includes('window')))
      },
    )
  }
})

test('rejects extra or remote capability references in the base config', async () => {
  for (const capabilities of [['default', 'wide'], ['remote']]) {
    await withFixture(
      baseFiles({
        'services/admin/src-tauri/tauri.conf.json': JSON.stringify({
          app: {
            windows: [{ label: 'main' }],
            security: {
              ...JSON.parse(cleanConfig).app.security,
              capabilities,
            },
          },
        }),
      }),
      async (root) => {
        const violations = await validateTauriBoundary(root)
        assert.ok(violations.some((violation) => violation.includes('capability reference')))
      },
    )
  }
})

test('applies the same capability boundary to TOML files', async () => {
  await withFixture(
    baseFiles({
      'services/example_tauri_service/src-tauri/capabilities/wide.toml': [
        'identifier = "wide"',
        'windows = ["main", "settings"]',
        'webviews = ["main"]',
        'permissions = ["allow-api-request"]',
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('wide.toml')))
      assert.ok(violations.some((violation) => violation.includes('webview capability access')))
      assert.ok(violations.some((violation) => violation.includes('exactly the local main window')))
    },
  )
})

test('keeps example_tauri_service Tauri devUrl on its strict Web Vite port', async () => {
  const viteConfig = await readFile(
    join(process.cwd(), 'services/example_tauri_service/vite.config.ts'),
    'utf8',
  )
  assert.match(viteConfig, /port:\s*5175/)
  assert.match(viteConfig, /strictPort:\s*true/)
  assert.match(viteConfig, /TAURI_DEV_HOST/)

  const tauriConfig = JSON.parse(
    await readFile(
      join(process.cwd(), 'services/example_tauri_service/src-tauri/tauri.conf.json'),
      'utf8',
    ),
  )
  assert.equal(tauriConfig.build.devUrl, 'http://localhost:5175')
})

test('rejects forbidden Tauri plugin imports in admin web production code', async () => {
  for (const plugin of [
    '@tauri-apps/plugin-http',
    '@tauri-apps/plugin-fs',
    '@tauri-apps/plugin-shell',
    '@tauri-apps/plugin-opener',
    '@tauri-apps/plugin-store',
    '@tauri-apps/plugin-stronghold',
  ]) {
    await withFixture(
      baseFiles({ 'services/admin/src/web/App.tsx': `import '${plugin}'\n` }),
      async (root) => {
        const violations = await validateTauriBoundary(root)
        assert.ok(violations.some((violation) => violation.includes(plugin)))
      },
    )
  }
})

test('rejects Tauri plugin references in Rust dependencies, builder, and config', async () => {
  await withFixture(
    baseFiles({
      'services/example_tauri_service/src-tauri/Cargo.toml':
        '[dependencies]\ntauri-plugin-fs = "2"\n',
      'services/example_tauri_service/src-tauri/src/lib.rs':
        'tauri::Builder::default().plugin(tauri_plugin_fs::init());\n',
      'services/example_tauri_service/src-tauri/tauri.conf.json': JSON.stringify({
        plugins: { fs: {} },
        app: { security: JSON.parse(exampleTauriCleanConfig).app.security },
      }),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('tauri-plugin-fs')))
      assert.ok(violations.some((violation) => violation.includes('.plugin(')))
      assert.ok(violations.some((violation) => violation.includes('plugins configuration')))
    },
  )
})

test('requires the exact top-level navigation guard in each Tauri shell', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src-tauri/src/lib.rs': 'tauri::Builder::default();\n',
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('navigation guard')))
    },
  )
})

test('rejects plugin configuration in platform overlays', async () => {
  await withFixture(
    baseFiles({
      'services/example_tauri_service/src-tauri/tauri.ios.conf.json': JSON.stringify({
        plugins: { fs: {} },
      }),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('tauri.ios.conf.json')))
      assert.ok(violations.some((violation) => violation.includes('plugins configuration')))
    },
  )
})

test('rejects security and capability overrides in platform overlays', async () => {
  for (const app of [
    { security: { csp: "connect-src 'self' *" } },
    { security: { capabilities: ['unsafe'] } },
    { windows: [{ label: 'remote', url: 'https://attacker.example' }] },
  ]) {
    await withFixture(
      baseFiles({
        'services/example_tauri_service/src-tauri/tauri.ios.conf.json': JSON.stringify({
          app,
        }),
      }),
      async (root) => {
        const violations = await validateTauriBoundary(root)
        assert.ok(
          violations.some(
            (violation) =>
              violation.includes('tauri.ios.conf.json') &&
              (violation.includes('security configuration') ||
                violation.includes('window configuration')),
          ),
        )
      },
    )
  }
})

test('rejects raw fetch outside the transport source and ignores tests and dist', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/Orgs.tsx': 'export const load = () => fetch("/api/orgs")\n',
      'services/admin/src/web/routes/Orgs.test.tsx': 'fetch("/api/test")\n',
      'services/admin/dist/generated.js': 'fetch("/api/dist")\n',
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.equal(violations.filter((violation) => violation.includes('raw fetch')).length, 1)
      assert.ok(violations.some((violation) => violation.includes('routes/Orgs.tsx')))
    },
  )
})

test('rejects a test-named module when production code imports it', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/App.tsx': [
        "import { unsafeFetch } from './bridge.test'",
        'export function App() { unsafeFetch(); return null }',
      ].join('\n'),
      'services/admin/src/web/bridge.test.ts':
        "export function unsafeFetch() { return fetch('/api/escaped') }\n",
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(
        violations.some(
          (violation) =>
            violation.includes('bridge.test.ts') && violation.includes('production source'),
        ),
      )
    },
  )
})

test('checks example_tauri_service raw fetch outside its platform transport source', async () => {
  await withFixture(
    baseFiles({
      'services/example_tauri_service/src/web/routes/Items.tsx':
        'export const load = () => fetch("/api/items")\n',
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('example_tauri_service')))
      assert.ok(violations.some((violation) => violation.includes('raw fetch')))
    },
  )
})

test('allows only the documented example_tauri_service Web session fallback', async () => {
  await withFixture(
    baseFiles({
      'services/example_tauri_service/src/web/platform/transport.ts': nativeTransport,
      'services/example_tauri_service/src/web/auth/session.ts': [
        "import { platformFetch } from '../platform/transport'",
        "const DEV_TOKEN_KEY = 'app.example_tauri_service.auth.token'",
        "const DEV_ORG_KEY = 'app.example_tauri_service.auth.org'",
        'export async function devLogin(organizationId: string) {',
        "  const response = await platformFetch('/api/auth/token')",
        '  const { token } = await response.json()',
        '  sessionStorage.setItem(DEV_TOKEN_KEY, token)',
        '  sessionStorage.setItem(DEV_ORG_KEY, organizationId)',
        '}',
      ].join('\n'),
    }),
    async (root) => assert.deepEqual(await validateTauriBoundary(root), []),
  )
})

test('rejects arbitrary example_tauri_service browser storage writes', async () => {
  await withFixture(
    baseFiles({
      'services/example_tauri_service/src/web/auth/other.ts':
        "sessionStorage.setItem('refresh', token)\n",
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('example_tauri_service')))
      assert.ok(violations.some((violation) => violation.includes('browser storage write')))
    },
  )
})

test('rejects raw fetch in a transport-named file outside the fixed platform path', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/feature/transport.ts':
        'export const load = () => fetch("/api/orgs")\n',
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('feature/transport.ts')))
    },
  )
})

test('rejects computed and aliased fetch access outside the platform transport source', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/Indirect.tsx': [
        "const direct = globalThis['fetch']",
        'const aliased = direct',
        "const windowFetch = window['fetch']",
        'direct("/api/direct")',
        'aliased("/api/aliased")',
        'windowFetch("/api/window")',
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.filter((violation) => violation.includes('raw fetch')).length >= 3)
    },
  )
})

test('rejects global-object aliases and optional computed fetch access outside transport', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/ReviewFetch.tsx': [
        'const browser = globalThis',
        "browser['fetch']('/api/alias')",
        "globalThis?.['fetch']('/api/optional')",
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.filter((violation) => violation.includes('raw fetch')).length >= 2)
    },
  )
})

test('rejects concatenated properties and destructured fetch aliases', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/ReviewFetchAliases.tsx': [
        "globalThis['fe' + 'tch']('/api/concat')",
        'const { fetch: request } = window',
        "request('/api/destructure')",
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.filter((violation) => violation.includes('raw fetch')).length >= 2)
    },
  )
})

test('checks mts and cts web sources and rejects web symlinks', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/Module.mts': "fetch('/api/mts')\n",
      'services/admin/src/web/routes/Module.cts': "fetch('/api/cts')\n",
    }),
    async (root) => {
      await symlink(
        join(root, 'services/admin/src/web/App.tsx'),
        join(root, 'services/admin/src/web/routes/Linked.tsx'),
      )
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('Module.mts')))
      assert.ok(violations.some((violation) => violation.includes('Module.cts')))
      assert.ok(violations.some((violation) => violation.includes('Linked.tsx')))
    },
  )
})

test('rejects symlinks in Tauri source and capability directories', async () => {
  await withFixture(baseFiles(), async (root) => {
    await mkdir(join(root, 'services/admin/src-tauri/src'), { recursive: true })
    await symlink(
      join(root, 'services/admin/src/web/App.tsx'),
      join(root, 'services/admin/src-tauri/src/linked.rs'),
    )
    await symlink(
      join(root, 'services/admin/src-tauri/capabilities/default.json'),
      join(root, 'services/admin/src-tauri/capabilities/linked.json'),
    )
    const violations = await validateTauriBoundary(root)
    assert.ok(violations.some((violation) => violation.includes('src-tauri/src/linked.rs')))
    assert.ok(violations.some((violation) => violation.includes('capabilities/linked.json')))
  })
})

test('fails closed on unknown computed boundary properties', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/UnknownBoundary.tsx': [
        'const property = userInput',
        'globalThis[property]("/api/unknown")',
        'sessionStorage[property]("refresh", token)',
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('raw fetch')))
      assert.ok(violations.some((violation) => violation.includes('storage')))
    },
  )
})

test('rejects credential keys saved to browser storage', async () => {
  for (const key of ['refresh', 'accessToken', 'password', 'credential']) {
    await withFixture(
      baseFiles({
        'services/admin/src/web/auth/bad.ts': `sessionStorage.setItem('${key}', value)\n`,
      }),
      async (root) => {
        const violations = await validateTauriBoundary(root)
        assert.ok(violations.some((violation) => violation.includes(key)))
      },
    )
  }
})

test('allows only the documented development token fallback', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/auth/session.ts': [
        "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
        'sessionStorage.setItem(DEV_TOKEN_KEY, token)',
      ].join('\n'),
      'services/admin/src/web/auth/other.ts':
        "localStorage.setItem('app.admin.dev.token', token)\n",
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('allowlist')))
      assert.ok(violations.some((violation) => violation.includes('auth/other.ts')))
    },
  )
})

test('rejects dynamic or non-session development token storage writes', async () => {
  for (const [file, source] of [
    [
      'services/admin/src/web/auth/session.ts',
      [
        "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
        'const key = DEV_TOKEN_KEY',
        'export async function devLogin() { sessionStorage.setItem(key, token) }',
      ].join('\n'),
    ],
    [
      'services/admin/src/web/auth/other.ts',
      "sessionStorage.setItem('app.admin.dev.token', token)\n",
    ],
    ['services/admin/src/web/auth/other.ts', "localStorage['app.admin.dev.token'] = token\n"],
    [
      'services/admin/src/web/auth/other.ts',
      "Storage.prototype.setItem.call(sessionStorage, 'app.admin.dev.token', token)\n",
    ],
    [
      'services/admin/src/web/auth/other.ts',
      "const storage = sessionStorage\nstorage.setItem('accessToken', token)\n",
    ],
  ]) {
    await withFixture(baseFiles({ [file]: source }), async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes(file)))
    })
  }
})

test('rejects development storage writes whose value is not the dev grant response token', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/auth/session.ts': [
        "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
        "const refreshCredential = 'refresh-secret'",
        'const token = refreshCredential',
        'export async function devLogin() {',
        "  const res = await platformFetch('/api/auth/token')",
        '  sessionStorage.setItem(DEV_TOKEN_KEY, token)',
        '}',
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('storage')))
    },
  )
})

test('rejects dev fallback writes whose token identifier is lexically shadowed', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/auth/session.ts': [
        "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
        'export async function devLogin() {',
        "  const res = await platformFetch('/api/auth/token')",
        '  const { token } = await res.json()',
        '  const persist = (token) => sessionStorage.setItem(DEV_TOKEN_KEY, token)',
        '  persist(refreshCredential)',
        '}',
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('storage')))
    },
  )
})

test('rejects computed and aliased browser storage writes', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/auth/session.ts': [
        "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
        'const store = globalThis["sessionStorage"]',
        'const writeStore = store',
        "const key = 'arbitrary'",
        'export async function devLogin() {',
        "  const res = await platformFetch('/api/auth/token')",
        '  const { token } = await res.json()',
        '  writeStore.setItem(DEV_TOKEN_KEY, token)',
        '}',
        "sessionStorage[key].setItem('access', token)",
        "window['sessionStorage'].setItem('credential', token)",
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('storage')))
    },
  )
})

test('rejects browser storage writes through review escape forms', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/auth/ReviewStorage.ts': [
        'const browser = globalThis',
        "const store = browser['sessionStorage']",
        "store.setItem('refresh', token)",
        "sessionStorage.setItem?.('refresh', token)",
        "Storage.prototype['setItem'].call(sessionStorage, 'refresh', token)",
        "Reflect.apply(Storage.prototype.setItem, sessionStorage, ['refresh', token])",
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.filter((violation) => violation.includes('storage')).length >= 4)
    },
  )
})

test('rejects concatenated and destructured storage method aliases', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/auth/ReviewStorageAliases.ts': [
        "globalThis['session' + 'Storage']['set' + 'Item']('refresh', token)",
        'const { sessionStorage: store } = window',
        'const { setItem: write } = store',
        "write('refresh', token)",
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.filter((violation) => violation.includes('storage')).length >= 2)
    },
  )
})

test('rejects aliased Storage.prototype and Reflect.apply writes', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/auth/ReviewIndirectStorage.ts': [
        'const proto = Storage.prototype',
        "const writeMethod = proto['setItem']",
        "writeMethod.call(sessionStorage, 'refresh', token)",
        'const apply = Reflect.apply',
        "apply(Storage.prototype.setItem, sessionStorage, ['refresh', token])",
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.filter((violation) => violation.includes('storage')).length >= 2)
    },
  )
})

test('rejects bind aliases for fetch, storage methods, and Reflect.apply', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/ReviewBind.tsx': [
        'const request = fetch.bind(globalThis)',
        "request('/api/bind')",
      ].join('\n'),
      'services/admin/src/web/auth/ReviewBind.ts': [
        'const write = sessionStorage.setItem.bind(sessionStorage)',
        "write('refresh', token)",
        'const apply = Reflect.apply.bind(Reflect)',
        "apply(Storage.prototype.setItem, sessionStorage, ['refresh', token])",
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('raw fetch')))
      assert.ok(violations.filter((violation) => violation.includes('storage')).length >= 2)
    },
  )
})

test('rejects destructuring assignment aliases for fetch and storage', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/routes/ReviewDestructureAssignment.tsx': [
        'let request',
        '({ fetch: request } = globalThis)',
        "request('/api/destructure-assignment')",
      ].join('\n'),
      'services/admin/src/web/auth/ReviewDestructureAssignment.ts': [
        'let write',
        '({ setItem: write } = sessionStorage)',
        "write('refresh', token)",
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('raw fetch')))
      assert.ok(violations.some((violation) => violation.includes('storage')))
    },
  )
})

test('rejects dev fallback token parameters, reassignment, and block shadowing', async () => {
  for (const body of [
    '  const persist = (token) => sessionStorage.setItem(DEV_TOKEN_KEY, token)\n  persist(refreshCredential)',
    '  token = refreshCredential\n  sessionStorage.setItem(DEV_TOKEN_KEY, token)',
    '  { const token = refreshCredential\n    sessionStorage.setItem(DEV_TOKEN_KEY, token)\n  }',
  ]) {
    await withFixture(
      baseFiles({
        'services/admin/src/web/auth/session.ts': [
          "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
          'export async function devLogin() {',
          "  const res = await platformFetch('/api/auth/token')",
          '  const { token } = await res.json()',
          body,
          '} ',
        ].join('\n'),
      }),
      async (root) => {
        const violations = await validateTauriBoundary(root)
        assert.ok(violations.some((violation) => violation.includes('storage')))
      },
    )
  }
})

test('rejects dev fallback response rebinding and shadowing', async () => {
  for (const body of [
    '  res = attackerResponse\n  const { token } = await res.json()\n  sessionStorage.setItem(DEV_TOKEN_KEY, token)',
    '  { const res = attackerResponse\n    const { token } = await res.json()\n    sessionStorage.setItem(DEV_TOKEN_KEY, token)\n  }',
  ]) {
    await withFixture(
      baseFiles({
        'services/admin/src/web/auth/session.ts': [
          "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
          'export async function devLogin() {',
          "  let res = await platformFetch('/api/auth/token')",
          body,
          '} ',
        ].join('\n'),
      }),
      async (root) => {
        const violations = await validateTauriBoundary(root)
        assert.ok(violations.some((violation) => violation.includes('storage')))
      },
    )
  }
})

test('rejects a shadowed platform transport function in dev fallback', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/platform/transport.ts': 'export const platformFetch = safeFetch\n',
      'services/admin/src/web/auth/session.ts': [
        "import { platformFetch as importedPlatformFetch } from '../platform/transport'",
        "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
        'export async function devLogin() {',
        '  const platformFetch = attacker',
        "  const res = await platformFetch('/api/auth/token')",
        '  const { token } = await res.json()',
        '  sessionStorage.setItem(DEV_TOKEN_KEY, token)',
        '} ',
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('storage')))
    },
  )
})

test('rejects unsafe CSP sources and permits the fixed IPC development sources', async () => {
  for (const source of [
    "connect-src 'self' *",
    "connect-src 'self' https:",
    "connect-src 'self' https://admin.example.com",
    "connect-src 'self' http://*",
    "connect-src 'self' plugin-http: cors:",
    "connect-src 'self' wss://attacker.example",
    "connect-src 'self' ws:",
    "connect-src 'self' data:",
    "connect-src 'self' https://*",
    "connect-src 'self' *.example.com",
  ]) {
    await withFixture(
      baseFiles({
        'services/admin/src-tauri/tauri.conf.json': JSON.stringify({
          app: { security: { csp: source } },
        }),
      }),
      async (root) => assert.ok((await validateTauriBoundary(root)).some((v) => v.includes('CSP'))),
    )
  }
})

test('rejects missing, empty, or non-object CSP configuration', async () => {
  for (const security of [
    {},
    { csp: null, devCsp: cleanConfigValue('devCsp') },
    { csp: {}, devCsp: cleanConfigValue('devCsp') },
    { csp: cleanConfigValue('csp'), devCsp: null },
    { csp: cleanConfigValue('csp'), devCsp: {} },
    { csp: "default-src 'self'", devCsp: cleanConfigValue('devCsp') },
  ]) {
    await withFixture(
      baseFiles({
        'services/admin/src-tauri/tauri.conf.json': JSON.stringify({ app: { security } }),
      }),
      async (root) => {
        const violations = await validateTauriBoundary(root)
        assert.ok(violations.some((violation) => /CSP|tauri\.conf\.json/i.test(violation)))
      },
    )
  }

  await withFixture(
    {
      'services/admin/src/web/App.tsx': 'export function App() { return null }\n',
      'services/admin/src-tauri/capabilities/default.json': cleanCapability,
    },
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('tauri.conf.json')))
    },
  )
})

test('rejects filesystem, shell, opener, and HTTP plugin capability permissions', async () => {
  for (const permission of ['fs:default', 'shell:allow-open', 'opener:default', 'http:default']) {
    await withFixture(
      baseFiles({
        'services/admin/src-tauri/capabilities/default.json': JSON.stringify({
          permissions: [permission],
        }),
      }),
      async (root) =>
        assert.ok((await validateTauriBoundary(root)).some((v) => v.includes(permission))),
    )
  }
})

test('rejects capability permissions outside the exact API command allowlist', async () => {
  for (const permission of ['core:default', 'unknown:default', 'allow-api-request-extra']) {
    await withFixture(
      baseFiles({
        'services/example_tauri_service/src-tauri/capabilities/default.json': JSON.stringify({
          permissions: ['allow-api-request', permission],
        }),
      }),
      async (root) =>
        assert.ok((await validateTauriBoundary(root)).some((v) => v.includes(permission))),
    )
  }
})

test('checks TOML capabilities with the same exact permission allowlist', async () => {
  await withFixture(
    baseFiles({
      'services/example_tauri_service/src-tauri/capabilities/review.toml': [
        'identifier = "review"',
        'windows = ["main"]',
        'permissions = ["core:default"]',
      ].join('\n'),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((v) => v.includes('capabilities/review.toml')))
      assert.ok(violations.some((v) => v.includes('core:default')))
    },
  )
})

test('rejects server secrets mentioned in src-tauri source or config', async () => {
  for (const secret of [
    'JWT_SECRET',
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'AUTH_DEV_PRIVATE_KEY',
    'AUTH_PEPPER',
    'DOMAIN_TO_ADMIN_KEY',
    'ADMIN_TO_EXAMPLE_SERVICE_KEY',
    'ADMIN_TO_NOTIFIER_KEY',
    'DOMAIN_TO_NOTIFIER_KEY',
    'OPS_TO_NOTIFIER_KEY',
    'INTERNAL_KEY',
    'D1_EXPORT_API_TOKEN',
    'R2_POLICY_CHECK_API_TOKEN',
    'BACKUP_SIGNING_PRIVATE_KEY',
    'RESEND_API_KEY',
  ]) {
    await withFixture(
      baseFiles({ 'services/admin/src-tauri/src/lib.rs': `const name = "${secret}";\n` }),
      async (root) =>
        assert.ok((await validateTauriBoundary(root)).some((v) => v.includes(secret))),
    )
  }
})

test('allows inline styles only in the development CSP', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src-tauri/tauri.conf.json': JSON.stringify({
        app: {
          windows: [{ label: 'main', title: 'Test' }],
          security: {
            capabilities: ['default'],
            csp: { ...cleanConfigValue('csp'), 'style-src': "'self' 'unsafe-inline'" },
            devCsp: cleanConfigValue('devCsp'),
          },
        },
      }),
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes("'unsafe-inline'")))
    },
  )
})
