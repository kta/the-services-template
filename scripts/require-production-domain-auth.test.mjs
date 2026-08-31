import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isProductionDomainAuthReady,
  requireProductionDomainAuth,
} from './require-production-domain-auth.mjs'

const repositoryCatalog = {
  services: [
    { directory: 'admin', package: '@app/admin', deployable: true },
    { directory: 'example_service', package: '@app/example_service', deployable: false },
    {
      directory: 'example_tauri_service',
      package: '@app/example_tauri_service',
      deployable: false,
    },
  ],
  workerOnlyServices: [
    { directory: 'notifier', package: '@app/notifier', deployable: true },
    { directory: 'ops', package: '@app/ops', deployable: true },
  ],
}

const bookingCatalog = {
  services: [
    { directory: 'admin', package: '@app/admin', deployable: true },
    { directory: 'booking', package: '@app/booking', deployable: true },
  ],
  workerOnlyServices: [],
}

test('scaffold and reserved/path-traversal services are not production-ready', () => {
  assert.equal(
    isProductionDomainAuthReady('example_service', process.cwd(), repositoryCatalog),
    false,
  )
  assert.equal(
    isProductionDomainAuthReady('example_tauri_service', process.cwd(), repositoryCatalog),
    false,
  )
  assert.equal(
    isProductionDomainAuthReady('unknown_service', process.cwd(), repositoryCatalog),
    false,
  )
  assert.equal(isProductionDomainAuthReady('../booking', process.cwd(), repositoryCatalog), false)
  assert.throws(
    () => requireProductionDomainAuth('example_tauri_service', process.cwd(), repositoryCatalog),
    /catalog deployable/i,
  )
})

test('requires a real production auth module, worker integration, and focused test', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'production-domain-auth-'))
  try {
    const serviceRoot = join(fixtureRoot, 'services/booking')
    mkdirSync(join(serviceRoot, 'src/worker'), { recursive: true })
    mkdirSync(join(serviceRoot, 'test'), { recursive: true })
    writeFileSync(
      join(serviceRoot, 'src/worker/production-auth.ts'),
      [
        "import { domainAccessTokenAudience } from '@app/contracts'",
        "import { requireActiveOrg, requireLiveDomainSession, tenantAuth } from '@app/shared'",
        "import { compose } from 'hono/compose'",
        'export function productionAuthMiddleware(resolve) {',
        "  const audience = domainAccessTokenAudience('booking')",
        '  return compose(tenantAuth(undefined, audience), requireLiveDomainSession(), requireActiveOrg(resolve))',
        '}',
      ].join('\n'),
    )
    writeFileSync(
      join(serviceRoot, 'src/worker/index.ts'),
      [
        "import { Hono } from 'hono'",
        "import { productionAuthMiddleware } from './production-auth'",
        'const app = new Hono()',
        "app.use('/api/*', productionAuthMiddleware(resolve))",
      ].join('\n'),
    )
    writeFileSync(
      join(serviceRoot, 'test/production-auth.test.ts'),
      [
        "import { productionAuthMiddleware } from '../src/worker/production-auth'",
        "test('rejects unauthenticated requests', async () => {",
        "  app.use('/api/*', productionAuthMiddleware(resolve))",
        "  const response = await app.request('/api/items')",
        '  expect(response.status).toBe(401)',
        '})',
      ].join('\n'),
    )

    assert.equal(isProductionDomainAuthReady('booking', fixtureRoot, bookingCatalog), false)
    assert.throws(
      () => requireProductionDomainAuth('booking', fixtureRoot, bookingCatalog),
      /approved issuer or gateway.*positive live-session/i,
    )

    writeFileSync(
      join(serviceRoot, 'src/worker/production-auth.ts'),
      'export const productionAuthMiddleware = () => undefined\n',
    )
    assert.equal(isProductionDomainAuthReady('booking', fixtureRoot, bookingCatalog), false)

    writeFileSync(
      join(serviceRoot, 'src/worker/production-auth.ts'),
      [
        '// export const productionAuthMiddleware = marker-only',
        'export const productionAuthMiddleware = async (_c, next) => next()',
        "// domainAccessTokenAudience('booking') and checkSession(sid) in prose do not count",
      ].join('\n'),
    )
    assert.equal(isProductionDomainAuthReady('booking', fixtureRoot, bookingCatalog), false)

    writeFileSync(
      join(serviceRoot, 'src/worker/production-auth.ts'),
      [
        "import { domainAccessTokenAudience } from '@app/contracts'",
        "import { requireActiveOrg, requireLiveDomainSession, tenantAuth } from '@app/shared'",
        'export const productionAuthMiddleware = async (c, next) => {',
        "  const audience = domainAccessTokenAudience('booking')",
        '  if (false) {',
        '    await tenantAuth(c, audience)',
        '    await requireLiveDomainSession()(c, next)',
        '    await requireActiveOrg(c)',
        '  }',
        '  return next()',
        '}',
      ].join('\n'),
    )
    assert.equal(isProductionDomainAuthReady('booking', fixtureRoot, bookingCatalog), false)

    writeFileSync(
      join(serviceRoot, 'src/worker/production-auth.ts'),
      [
        "import { domainAccessTokenAudience } from '@app/contracts'",
        "import { requireActiveOrg, requireLiveDomainSession, tenantAuth } from '@app/shared'",
        'export const productionAuthMiddleware = async (c, next) => {',
        "  const audience = domainAccessTokenAudience('booking')",
        '  await tenantAuth(c, audience)',
        '  await requireLiveDomainSession()(c, next)',
        '  await requireActiveOrg(c)',
        '  return next()',
        '}',
      ].join('\n'),
    )
    writeFileSync(
      join(serviceRoot, 'src/worker/index.ts'),
      [
        "import { Hono } from 'hono'",
        "import { productionAuthMiddleware } from './production-auth'",
        'const app = new Hono()',
        'function wireRoutes() {',
        "  app.use('/api/*', productionAuthMiddleware)",
        '}',
      ].join('\n'),
    )
    assert.equal(isProductionDomainAuthReady('booking', fixtureRoot, bookingCatalog), false)

    writeFileSync(
      join(serviceRoot, 'src/worker/production-auth.ts'),
      [
        "import { domainAccessTokenAudience } from '@app/contracts'",
        "import { requireActiveOrg, requireLiveDomainSession, tenantAuth } from '@app/shared'",
        'export const productionAuthMiddleware = async (c, next) => {',
        "  const audience = domainAccessTokenAudience('booking')",
        '  await tenantAuth(c, audience)',
        '  await requireLiveDomainSession()(c, next)',
        '  await requireActiveOrg(c)',
        '  return next()',
        '}',
      ].join('\n'),
    )
    writeFileSync(
      join(serviceRoot, 'test/production-auth.test.ts'),
      "test('marker-only assertion is insufficient', () => { app.use('/api/*', productionAuthMiddleware); expect(true).toBe(true) })",
    )
    assert.equal(isProductionDomainAuthReady('booking', fixtureRoot, bookingCatalog), false)

    writeFileSync(
      join(serviceRoot, 'test/production-auth.test.ts'),
      [
        "import { productionAuthMiddleware } from '../src/worker/production-auth'",
        "test('rejects unauthenticated requests', async () => {",
        "  app.use('/api/*', productionAuthMiddleware)",
        "  const response = await app.request('/api/items')",
        '  expect(response.status).toBe(401)',
        '})',
      ].join('\n'),
    )
    writeFileSync(
      join(serviceRoot, 'src/worker/production-auth.ts'),
      [
        "import { domainAccessTokenAudience } from '@app/contracts'",
        "import { requireActiveOrg, requireLiveDomainSession, tenantAuth } from '@app/contracts'",
        'export const productionAuthMiddleware = async (c, next) => {',
        "  const audience = domainAccessTokenAudience('booking')",
        '  await tenantAuth(c, audience)',
        '  await requireActiveOrg(c)',
        '  return next()',
        '}',
      ].join('\n'),
    )
    assert.equal(isProductionDomainAuthReady('booking', fixtureRoot, bookingCatalog), false)

    writeFileSync(
      join(serviceRoot, 'src/worker/index.ts'),
      [
        "import { productionAuthMiddleware } from './production-auth'",
        'const app = { use() {} }',
        "app.use('/api/*', productionAuthMiddleware)",
      ].join('\n'),
    )
    assert.equal(isProductionDomainAuthReady('booking', fixtureRoot, bookingCatalog), false)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
