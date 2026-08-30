import assert from 'node:assert/strict'
import test from 'node:test'
import { validateServiceWiringSources } from './service-wiring.mjs'

const services = [
  { directory: 'admin', package: '@app/admin', deployable: true },
  { directory: 'example_service', package: '@app/example_service', deployable: false },
  { directory: 'example_tauri_service', package: '@app/example_tauri_service', deployable: false },
]
const workerOnlyServices = ['notifier', 'ops']

function validSources() {
  return {
    makefile: 'DEV_ALL_SERVICES := admin example_service example_tauri_service\n',
    packageJson: JSON.stringify({
      scripts: {
        test: 'pnpm --filter @app/admin test:all && pnpm --filter @app/example_service test:all && pnpm --filter @app/example_tauri_service test:all && pnpm --filter @app/notifier test',
      },
    }),
    ci: `
  e2e:
    matrix:
      include:
        - { name: admin, pkg: '@app/admin', dir: services/admin }
        - { name: example_service, pkg: '@app/example_service', dir: services/example_service }
        - { name: example_tauri_service, pkg: '@app/example_tauri_service', dir: services/example_tauri_service }
  build-production:
      - run: pnpm --filter @app/notifier run build
      - run: pnpm --filter @app/admin run build
      - run: pnpm --filter @app/ops run build
      - run: node verify-worker-artifact.mjs --service admin --service notifier --service ops
  deploy:
      - name: Deploy notifier
      - name: Deploy admin
      - name: Deploy ops
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
    .replace('pnpm --filter @app/admin run build\n', '')
    .replace(' --service admin', '')
    .replace('      - name: Deploy admin\n', '')
    .replace(
      '      - name: Deploy ops\n',
      '      - name: Deploy ops\n      - name: Deploy example_service\n',
    )
  const diagnostic = validateServiceWiringSources({ services, workerOnlyServices }, sources).join(
    '\n',
  )
  assert.match(diagnostic, /production build.*missing @app\/admin/i)
  assert.match(diagnostic, /production artifact.*missing admin/i)
  assert.match(diagnostic, /production deploy.*missing admin.*extra example_service/i)
})
