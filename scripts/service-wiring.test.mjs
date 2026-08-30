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
const trustedNode = '$' + '{{ steps.trusted-tools.outputs.node }}'
const trustedPnpm = '$' + '{{ steps.trusted-tools.outputs.pnpm }}'

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
      - name: Build admin (no Cloudflare credentials)
        run: node scripts/production-service.mjs admin build
      - name: Build notifier (no Cloudflare credentials)
        run: node scripts/production-service.mjs notifier build
      - name: Build ops (no Cloudflare credentials)
        run: node scripts/production-service.mjs ops build
      - name: Verify and package production Worker bundles
        run: node scripts/production-artifacts.mjs ci package admin notifier ops
      - name: Record exact Worker bundle digest
        id: package-worker-artifact
        run: node scripts/production-artifacts.mjs ci record-digest
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Verify exact build artifact digest before credentials
        run: node scripts/production-artifacts.mjs ci verify-digest
      - name: Verify and install reviewed production Worker bundles
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-artifacts.mjs ci install admin notifier ops
      - name: Verify admin production config before credentials
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs admin config
      - name: Verify notifier production config before credentials
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs notifier config
      - name: Verify ops production config before credentials
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs ops config
      - name: Verify admin remote production secret names
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs admin remote-secrets
      - name: Verify notifier remote production secret names
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs notifier remote-secrets
      - name: Verify ops remote production secret names
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs ops remote-secrets
      - name: Deploy notifier
        env:
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs notifier deploy
      - name: Apply admin remote migrations
        env:
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs admin migrate
      - name: Deploy admin
        env:
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs admin deploy
      - name: Deploy ops
        env:
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs ops deploy
`,
    bootstrap: `
on: {workflow_dispatch: {}}
jobs:
  build-production:
    runs-on: ubuntu-latest
    steps:
      - name: Validate copied domain input before package selection
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
        run: node scripts/production-service.mjs "$DOMAIN_SERVICE" guard-domain
      - name: Build admin without Cloudflare credentials
        run: node scripts/production-service.mjs admin build
      - name: Build notifier without Cloudflare credentials
        run: node scripts/production-service.mjs notifier build
      - name: Build ops without Cloudflare credentials
        run: node scripts/production-service.mjs ops build
      - name: Build copied domain without Cloudflare credentials
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
        run: node scripts/production-service.mjs "$DOMAIN_SERVICE" build
      - name: Verify and package production Worker bundles
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
        run: node scripts/production-artifacts.mjs bootstrap package admin notifier ops "$DOMAIN_SERVICE"
      - name: Record exact Worker bundle digest
        id: package-worker-artifact
        run: node scripts/production-artifacts.mjs bootstrap record-digest
  bootstrap:
    runs-on: ubuntu-latest
    steps:
      - name: Require a catalog deployable domain before credentials
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
        run: node scripts/production-service.mjs "$DOMAIN_SERVICE" guard-domain
      - name: Verify exact build artifact digest before credentials
        run: node scripts/production-artifacts.mjs bootstrap verify-digest
      - name: Verify and install reviewed production Worker bundles
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-artifacts.mjs bootstrap install admin notifier ops "$DOMAIN_SERVICE"
      - name: Require protected main bootstrap boundary
        run: \${{ steps.trusted-tools.outputs.node }} scripts/require-production-bootstrap.mjs
      - name: Verify admin production config before credentials
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs admin config
      - name: Verify notifier production config before credentials
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs notifier config
      - name: Verify ops production config before credentials
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs ops config
      - name: Verify copied domain production config before credentials
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs "$DOMAIN_SERVICE" config
      - name: Verify admin remote production secret names
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs admin remote-secrets-bootstrap
      - name: Verify notifier remote production secret names
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs notifier remote-secrets-bootstrap
      - name: Verify copied domain remote production secret names
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs "$DOMAIN_SERVICE" remote-secrets-bootstrap
      - name: Verify ops remote production secret names
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs ops remote-secrets-bootstrap
      - name: Bootstrap notifier
        env:
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs notifier bootstrap
      - name: Bootstrap admin
        env:
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs admin bootstrap
      - name: Apply copied domain remote migrations
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs "$DOMAIN_SERVICE" migrate
      - name: Bootstrap copied domain
        env:
          DOMAIN_SERVICE: \${{ inputs.domain_service }}
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs "$DOMAIN_SERVICE" bootstrap
      - name: Bootstrap ops
        env:
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs ops bootstrap
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
    .replace(
      '      - name: Build admin (no Cloudflare credentials)\n        run: node scripts/production-service.mjs admin build\n',
      '',
    )
    .replace('ci package admin notifier ops', 'ci package example_service notifier ops')
    .replace(
      `${trustedNode} scripts/production-service.mjs admin deploy`,
      `${trustedNode} scripts/production-service.mjs example_service deploy`,
    )
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /production build step admin.*exact wrapper/i)
  assert.match(diagnostic, /production package.*exactly.*admin, notifier, ops/i)
  assert.match(diagnostic, /production deploy step admin.*exact wrapper/i)
})

test('rejects duplicate actual nodes, comment spoofing, and E2E identity mismatch', () => {
  const sources = validSources()
  sources.ci = sources.ci
    .replace(
      '      - name: Build admin (no Cloudflare credentials)\n        run: node scripts/production-service.mjs admin build\n',
      '      # node scripts/production-service.mjs admin build\n      - name: Build admin (no Cloudflare credentials)\n        run: node scripts/production-service.mjs admin build\n      - name: Build admin (no Cloudflare credentials)\n        run: node scripts/production-service.mjs admin build\n',
    )
    .replace(
      "        - { name: example_service, pkg: '@app/example_service', dir: services/example_service }",
      "        - { name: rogue, pkg: '@app/example_service', dir: services/example_service }",
    )
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /production build step admin.*exactly once/i)
  assert.match(diagnostic, /manual E2E matrix.*identity mismatch.*rogue/i)
  assert.match(diagnostic, /manual E2E matrix.*missing example_service/i)
})

test('requires artifact transport, install, config, migration, and bootstrap guards', () => {
  const sources = validSources()
  sources.ci = sources.ci
    .replace('ci package admin notifier ops', 'ci package notifier ops')
    .replace('ci install admin notifier ops', 'ci install notifier ops')
    .replace(
      / {6}- name: Verify admin production config before credentials[\s\S]*? admin config\n/,
      '',
    )
    .replace(/ {6}- name: Apply admin remote migrations[\s\S]*? admin migrate\n/, '')
  sources.bootstrap = sources.bootstrap.replace(
    / {6}- name: (?:Validate copied domain input before package selection|Require a catalog deployable domain before credentials)[\s\S]*? guard-domain\n/g,
    '',
  )
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /production package.*exactly.*admin, notifier, ops/i)
  assert.match(diagnostic, /production install.*exactly.*admin, notifier, ops/i)
  assert.match(diagnostic, /production config step admin.*exact wrapper/i)
  assert.match(diagnostic, /production migration step admin.*exact wrapper/i)
  assert.match(diagnostic, /production-bootstrap.*both jobs.*exact catalog domain guard/i)
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

test('rejects the non-deployable scaffold as an admin production binding when no domain deploys', () => {
  const sources = validSources()
  sources.adminConfig = JSON.stringify({
    services: [
      { binding: 'EXAMPLE_SERVICE', service: 'example-service' },
      { binding: 'NOTIFIER', service: 'notifier' },
    ],
  })
  sources.opsConfig = JSON.stringify({
    vars: { ADMIN_DB_ID: 'id' },
    services: [
      { binding: 'ADMIN', service: 'admin' },
      { binding: 'NOTIFIER', service: 'notifier' },
    ],
  })
  sources.opsSource = `
    { name: 'admin', databaseId: env.ADMIN_DB_ID, healthBinding: env.ADMIN },
    { name: 'notifier', healthBinding: env.NOTIFIER },
  `
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /admin production domain binding.*extra example_service/i)
})

test('rejects shell control, no-op text, traversal argv, wrong cwd, and wrong deploy identity', () => {
  for (const replacement of [
    'node scripts/production-service.mjs admin build || true',
    'false && node scripts/production-service.mjs admin build',
    "printf '%s\\n' 'node scripts/production-service.mjs admin build'",
  ]) {
    const sources = validSources()
    sources.ci = sources.ci.replace('node scripts/production-service.mjs admin build', replacement)
    assert.match(
      validateServiceWiringSources({ services, workerOnlyServices }, sources).join('\n'),
      /production build step admin.*exact wrapper/i,
    )
  }

  const traversal = validSources()
  traversal.ci = traversal.ci.replace(
    'ci package admin notifier ops',
    'ci package admin/../rogue notifier ops',
  )
  assert.match(
    validateServiceWiringSources({ services, workerOnlyServices }, traversal).join('\n'),
    /production package.*exactly.*admin, notifier, ops/i,
  )

  const wrongCwd = validSources()
  wrongCwd.ci = wrongCwd.ci.replace(
    `        run: ${trustedNode} scripts/production-service.mjs admin migrate`,
    `        working-directory: services/rogue\n        run: ${trustedNode} scripts/production-service.mjs admin migrate`,
  )
  assert.match(
    validateServiceWiringSources({ services, workerOnlyServices }, wrongCwd).join('\n'),
    /production migration step admin.*exact root step/i,
  )

  for (const rawCommand of [
    `${trustedPnpm} exec wrangler deploy dist/rogue/index.js --no-bundle`,
    `${trustedPnpm} exec wrangler deploy dist/admin/index.js --config=rogue.jsonc --no-bundle`,
  ]) {
    const sources = validSources()
    sources.ci = sources.ci.replace(
      `${trustedNode} scripts/production-service.mjs admin deploy`,
      rawCommand,
    )
    assert.match(
      validateServiceWiringSources({ services, workerOnlyServices }, sources).join('\n'),
      /production deploy step admin.*exact wrapper/i,
    )
  }

  const unexpectedEnv = validSources()
  unexpectedEnv.ci = unexpectedEnv.ci.replace(
    '      - name: Build admin (no Cloudflare credentials)\n        run:',
    '      - name: Build admin (no Cloudflare credentials)\n        env:\n          NODE_OPTIONS: --require ./rogue.cjs\n        run:',
  )
  assert.match(
    validateServiceWiringSources({ services, workerOnlyServices }, unexpectedEnv).join('\n'),
    /production build step admin.*unreviewed env.*NODE_OPTIONS/i,
  )
})

test('rejects echoed bootstrap guards and out-of-order wrapper execution', () => {
  const echoed = validSources()
  echoed.bootstrap = echoed.bootstrap.replaceAll(
    'node scripts/production-service.mjs "$DOMAIN_SERVICE" guard-domain',
    'echo \'node scripts/production-service.mjs "$DOMAIN_SERVICE" guard-domain\'',
  )
  assert.match(
    validateServiceWiringSources({ services, workerOnlyServices }, echoed).join('\n'),
    /production-bootstrap.*both jobs.*exact catalog domain guard/i,
  )

  const reordered = validSources()
  const migration = `      - name: Apply admin remote migrations
        env:
          PRODUCTION_PNPM_PATH: \${{ steps.trusted-tools.outputs.pnpm }}
        run: \${{ steps.trusted-tools.outputs.node }} scripts/production-service.mjs admin migrate
`
  reordered.ci = reordered.ci
    .replace(migration, '')
    .replace(
      '  deploy:\n    runs-on: ubuntu-latest\n    steps:\n',
      `  deploy:\n    runs-on: ubuntu-latest\n    steps:\n${migration}`,
    )
  assert.match(
    validateServiceWiringSources({ services, workerOnlyServices }, reordered).join('\n'),
    /production wrapper steps must follow the reviewed order/i,
  )
})
