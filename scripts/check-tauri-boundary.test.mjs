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
    security: {
      csp: {
        'default-src': "'self'",
        'base-uri': "'self'",
        'object-src': "'none'",
        'script-src': "'self'",
        'style-src': "'self' 'unsafe-inline'",
        'img-src': "'self' data:",
        'font-src': "'self'",
        'connect-src': "'self' ipc: http://ipc.localhost",
      },
      devCsp: {
        'default-src': "'self'",
        'base-uri': "'self'",
        'object-src': "'none'",
        'script-src': "'self'",
        'style-src': "'self' 'unsafe-inline'",
        'img-src': "'self' data:",
        'font-src': "'self'",
        'connect-src': "'self' ipc: http://ipc.localhost http://localhost:5174",
      },
    },
  },
})
const cleanConfigValue = (name) => JSON.parse(cleanConfig).app.security[name]
const exampleCleanConfig = cleanConfig.replaceAll('localhost:5174', 'localhost:5173')
const cleanCapability = JSON.stringify({
  identifier: 'default',
  windows: ['main'],
  permissions: ['allow-api-request'],
})

function baseFiles(extra = {}) {
  return {
    'services/admin/src/web/App.tsx': 'export function App() { return null }\n',
    'services/admin/src-tauri/tauri.conf.json': cleanConfig,
    'services/admin/src-tauri/capabilities/default.json': cleanCapability,
    'services/example_service/src/web/App.tsx': 'export function App() { return null }\n',
    'services/example_service/src-tauri/tauri.conf.json': exampleCleanConfig,
    'services/example_service/src-tauri/capabilities/default.json': cleanCapability,
    ...extra,
  }
}

test('accepts the current safe Tauri boundary', async () => {
  await withFixture(
    baseFiles({
      'services/admin/src/web/platform/transport.ts':
        'export function platformFetch() { return fetch("/api/items") }\n',
      'services/admin/src/web/auth/session.ts': [
        "import { platformFetch } from '../platform/transport'",
        "const DEV_TOKEN_KEY = 'app.admin.dev.token'",
        'export async function devLogin() {',
        "  const res = await platformFetch('/api/auth/token')",
        '  const { token } = await res.json()',
        '  sessionStorage.setItem(DEV_TOKEN_KEY, token)',
        '}',
      ].join('\n'),
    }),
    async (root) => assert.deepEqual(await validateTauriBoundary(root), []),
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

test('allows only the generated api_request app command permission', async () => {
  const capability = JSON.parse(
    await readFile(
      join(process.cwd(), 'services/admin/src-tauri/capabilities/default.json'),
      'utf8',
    ),
  )
  assert.deepEqual(capability.permissions, ['allow-api-request'])

  const buildScript = await readFile(
    join(process.cwd(), 'services/admin/src-tauri/build.rs'),
    'utf8',
  )
  assert.match(buildScript, /AppManifest::new\(\)\.commands\(&\["api_request"\]\)/)
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
      'services/example_service/src-tauri/Cargo.toml': '[dependencies]\ntauri-plugin-fs = "2"\n',
      'services/example_service/src-tauri/src/lib.rs':
        'tauri::Builder::default().plugin(tauri_plugin_fs::init());\n',
      'services/example_service/src-tauri/tauri.conf.json': JSON.stringify({
        plugins: { fs: {} },
        app: { security: JSON.parse(exampleCleanConfig).app.security },
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

test('rejects plugin configuration in platform overlays', async () => {
  await withFixture(
    baseFiles({
      'services/example_service/src-tauri/tauri.ios.conf.json': JSON.stringify({
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

test('checks example_service raw fetch outside its platform transport source', async () => {
  await withFixture(
    baseFiles({
      'services/example_service/src/web/routes/Items.tsx':
        'export const load = () => fetch("/api/items")\n',
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('example_service')))
      assert.ok(violations.some((violation) => violation.includes('raw fetch')))
    },
  )
})

test('allows only the documented example_service Web session fallback', async () => {
  await withFixture(
    baseFiles({
      'services/example_service/src/web/platform/transport.ts':
        'export function platformFetch() { return fetch("/api/items") }\n',
      'services/example_service/src/web/auth/session.ts': [
        "import { platformFetch } from '../platform/transport'",
        "const DEV_TOKEN_KEY = 'app.auth.token'",
        "const DEV_ORG_KEY = 'app.auth.org'",
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

test('rejects arbitrary example_service browser storage writes', async () => {
  await withFixture(
    baseFiles({
      'services/example_service/src/web/auth/other.ts':
        "sessionStorage.setItem('refresh', token)\n",
    }),
    async (root) => {
      const violations = await validateTauriBoundary(root)
      assert.ok(violations.some((violation) => violation.includes('example_service')))
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
        'services/example_service/src-tauri/capabilities/default.json': JSON.stringify({
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
      'services/example_service/src-tauri/capabilities/review.toml': [
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
  for (const secret of ['JWT_SECRET', 'AUTH_PEPPER', 'INTERNAL_KEY', 'RESEND']) {
    await withFixture(
      baseFiles({ 'services/admin/src-tauri/src/lib.rs': `const name = "${secret}";\n` }),
      async (root) =>
        assert.ok((await validateTauriBoundary(root)).some((v) => v.includes(secret))),
    )
  }
})
