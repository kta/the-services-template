import assert from 'node:assert/strict'
import test from 'node:test'
import { validateServiceWiringSources } from './service-wiring.mjs'

const services = [
  { directory: 'admin', package: '@app/admin', deployable: true },
  { directory: 'example_service', package: '@app/example_service', deployable: false },
  { directory: 'example_tauri_service', package: '@app/example_tauri_service', deployable: false },
]
const workerOnlyServices = [
  { directory: 'notifier', package: '@app/notifier', deployable: true },
  { directory: 'ops', package: '@app/ops', deployable: true },
]

function validSources() {
  return {
    makefile: 'DEV_ALL_SERVICES := admin example_service example_tauri_service\n',
    packageJson: JSON.stringify({
      scripts: {
        test: 'pnpm --filter @app/admin test:all && pnpm --filter @app/example_service test:all && pnpm --filter @app/example_tauri_service test:all && pnpm --filter @app/notifier test && pnpm --filter @app/ops test',
      },
    }),
    ci: `
on: {workflow_dispatch: {}}
jobs:
  e2e:
    strategy:
      matrix:
        include:
        - { name: admin, pkg: '@app/admin', dir: services/admin }
        - { name: example_service, pkg: '@app/example_service', dir: services/example_service }
        - { name: example_tauri_service, pkg: '@app/example_tauri_service', dir: services/example_tauri_service }
    runs-on: ubuntu-latest
    steps: []
  build-production:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --filter @app/notifier run build
      - run: pnpm --filter @app/admin run build
      - run: pnpm --filter @app/ops run build
      - run: |
          node scripts/verify-worker-artifact.mjs --service admin --service notifier --service ops
          tar -czf bundles.tar.gz services/admin/dist services/notifier/dist services/ops/dist
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/verify-worker-artifact.mjs --archive bundles.tar.gz --install-root . --service admin --service notifier --service ops
      - run: node scripts/check-production-config.mjs admin && node scripts/check-production-config.mjs notifier && node scripts/check-production-config.mjs ops
      - run: check_remote_secret_names admin && check_remote_secret_names notifier && check_remote_secret_names ops
      - name: Deploy notifier
        working-directory: services/notifier
        run: pnpm exec wrangler deploy dist/index.js --no-bundle
      - name: Apply admin remote migrations
        working-directory: services/admin
        run: pnpm exec wrangler d1 migrations apply DB --remote
      - name: Deploy admin
        working-directory: services/admin
        run: pnpm exec wrangler deploy dist/index.js --no-bundle
      - name: Deploy ops
        working-directory: services/ops
        run: pnpm exec wrangler deploy dist/index.js --no-bundle
`,
    bootstrap: `
on: {workflow_dispatch: {}}
jobs:
  build-production:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/service-catalog.mjs require-deployable "$DOMAIN_SERVICE"
      - run: pnpm --filter "@app/$DOMAIN_SERVICE" run build
      - run: |
          node scripts/verify-worker-artifact.mjs --service "$DOMAIN_SERVICE"
          tar -czf bundles.tar.gz "services/$DOMAIN_SERVICE/dist"
  bootstrap:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/service-catalog.mjs require-deployable "$DOMAIN_SERVICE"
      - run: |
          node scripts/verify-worker-artifact.mjs --service "$DOMAIN_SERVICE"
          node scripts/check-production-config.mjs "$DOMAIN_SERVICE"
          check_remote_secret_names "$DOMAIN_SERVICE"
          pnpm exec wrangler d1 migrations apply DB --remote
          pnpm exec wrangler deploy "dist/\${{ inputs.domain_service }}/index.js" --no-bundle
`,
    productionChecker:
      "import { loadServiceRepositoryCatalog } from './service-catalog.mjs'\nconst catalog = await loadServiceRepositoryCatalog(root)\n",
  }
}

test('accepts exact bidirectional SPA and production wiring', () => {
  assert.deepEqual(
    validateServiceWiringSources({ services, workerOnlyServices }, validSources()),
    [],
  )
})

test('rejects missing and extra SPA dev, combined-test, and E2E registrations', () => {
  const sources = validSources()
  sources.makefile = 'DEV_ALL_SERVICES := admin example_service stray\n'
  sources.packageJson = JSON.stringify({ scripts: { test: 'pnpm --filter @app/admin test:all' } })
  sources.ci = sources.ci.replace(
    "        - { name: example_tauri_service, pkg: '@app/example_tauri_service', dir: services/example_tauri_service }\n",
    '',
  )
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /DEV_ALL_SERVICES.*missing example_tauri_service.*extra stray/i)
  assert.match(
    diagnostic,
    /combined SPA test.*missing @app\/example_service, @app\/example_tauri_service/i,
  )
  assert.match(diagnostic, /manual E2E matrix.*missing example_tauri_service/i)
})

test('deployable true is required in every production surface while false is excluded', () => {
  const sources = validSources()
  sources.ci = sources.ci
    .replace('      - run: pnpm --filter @app/admin run build\n', '')
    .replace(' --service admin', '')
    .replace('      - name: Deploy admin\n', '      - name: Deploy example_service\n')
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /production build.*missing @app\/admin/i)
  assert.match(diagnostic, /production artifact.*missing admin/i)
  assert.match(diagnostic, /production deploy.*missing admin.*extra example_service/i)
})

test('rejects duplicate actual nodes, comment spoofing, and E2E identity mismatch', () => {
  const sources = validSources()
  sources.ci = sources.ci
    .replace(
      '      - run: pnpm --filter @app/admin run build\n',
      '      # pnpm --filter @app/admin run build\n      - run: pnpm --filter @app/admin run build\n      - run: pnpm --filter @app/admin run build\n',
    )
    .replace(
      "        - { name: example_service, pkg: '@app/example_service', dir: services/example_service }",
      "        - { name: rogue, pkg: '@app/example_service', dir: services/example_service }",
    )
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /production build.*duplicate @app\/admin/i)
  assert.match(diagnostic, /manual E2E matrix.*identity mismatch.*rogue/i)
  assert.match(diagnostic, /manual E2E matrix.*missing example_service/i)
})

test('requires artifact transport, install, config, migration, and bootstrap guards', () => {
  const sources = validSources()
  sources.ci = sources.ci
    .replace(' services/admin/dist', '')
    .replace(
      ' --service admin --service notifier --service ops\n      - run: node scripts/check-production-config',
      ' --service notifier --service ops\n      - run: node scripts/check-production-config',
    )
    .replace('node scripts/check-production-config.mjs admin && ', '')
    .replace(/ {6}- name: Apply admin remote migrations[\s\S]*?--remote\n/, '')
  sources.bootstrap = sources.bootstrap.replace(
    / {6}- run: node scripts\/service-catalog\.mjs require-deployable "\$DOMAIN_SERVICE"\n/g,
    '',
  )
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /production tar paths.*missing admin/i)
  assert.match(diagnostic, /production install verifier.*missing admin/i)
  assert.match(diagnostic, /production config verifier.*missing admin/i)
  assert.match(diagnostic, /production migration.*missing admin/i)
  assert.match(diagnostic, /production-bootstrap.*both jobs.*require-deployable/i)
})

test('root combined test requires worker-only test and rejects its test:all mode', () => {
  const sources = validSources()
  sources.packageJson = sources.packageJson.replace(
    'pnpm --filter @app/notifier test',
    'pnpm --filter @app/notifier test:all',
  )
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /root combined worker test.*missing @app\/notifier/i)
  assert.match(diagnostic, /root combined test.*wrong mode.*@app\/notifier.*test:all/i)
})

test('rejects non-deployable extras in D1, admin binding, and ops backup/health surfaces', () => {
  const sources = validSources()
  sources.adminConfig = JSON.stringify({
    services: [
      { binding: 'EXAMPLE_SERVICE', service: 'example-service' },
      { binding: 'BOOKING', service: 'booking' },
      { binding: 'NOTIFIER', service: 'notifier' },
    ],
  })
  sources.opsConfig = JSON.stringify({
    vars: { ADMIN_DB_ID: 'id', BOOKING_DB_ID: 'id' },
    services: [
      { binding: 'ADMIN', service: 'admin' },
      { binding: 'NOTIFIER', service: 'notifier' },
      { binding: 'BOOKING', service: 'booking' },
    ],
  })
  sources.opsSource = `
    { name: 'admin', databaseId: env.ADMIN_DB_ID, healthBinding: env.ADMIN },
    { name: 'notifier', healthBinding: env.NOTIFIER },
    { name: 'booking', databaseId: env.BOOKING_DB_ID, healthBinding: env.BOOKING },
  `
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /D1 resource identities.*extra booking/i)
  assert.match(diagnostic, /admin production domain binding.*extra booking/i)
  assert.match(diagnostic, /ops production health bindings.*extra booking/i)
  assert.match(diagnostic, /ops production backup\/health targets.*extra booking/i)
})
