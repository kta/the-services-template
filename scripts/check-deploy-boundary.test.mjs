import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveDomainSyncIdentity } from '../services/admin/src/worker/domain-sync-orchestration.mjs'
import { inspectNativeCliKnipPolicy } from './native-dependency-policy.mjs'
import {
  loadServiceCatalog,
  loadServiceRepositoryCatalog,
  validateServiceCatalog,
} from './service-catalog.mjs'
import { validateServiceWiring } from './service-wiring.mjs'
import { inspectNativeWorkflowPolicy } from './workflow-policy.mjs'

const root = process.cwd()

test('one exact root Knip exception covers every catalog native CLI without service allowlists', () => {
  const nativeServices = ['booking', 'billing', 'shipping'].map((directory) => ({
    directory,
    native: true,
  }))
  const workspaces = Object.fromEntries(
    nativeServices.map(({ directory }) => [`services/${directory}`, { entry: ['src/**/*.ts'] }]),
  )
  const config = {
    ignoreDependencies: ['^cloudflare(:.*)?$', '@tauri-apps/cli'],
    workspaces,
  }
  assert.deepEqual(inspectNativeCliKnipPolicy(config, nativeServices), [])

  assert.match(
    inspectNativeCliKnipPolicy(
      { ...config, ignoreDependencies: ['^cloudflare(:.*)?$'] },
      nativeServices,
    ).join('\n'),
    /one exact root.*@tauri-apps\/cli/i,
  )
  assert.match(
    inspectNativeCliKnipPolicy(
      {
        ...config,
        workspaces: {
          ...workspaces,
          'services/shipping': { ignoreDependencies: ['@tauri-apps/cli'] },
        },
      },
      nativeServices,
    ).join('\n'),
    /shipping.*must inherit.*root/i,
  )
})

test('production CI deploy is push-only on protected main', async () => {
  const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')
  const catalog = await loadServiceRepositoryCatalog(root)
  assert.deepEqual(await validateServiceWiring(root, catalog), [])
  assert.match(
    workflow,
    /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true/,
  )
  assert.match(
    workflow,
    /name: Require main branch protection for production boundary[\s\S]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'[\s\S]*?run: test "\$\{\{ github\.ref_protected \}\}" = "true"/,
  )
  assert.match(workflow, /environment:\s*production/)
  assert.doesNotMatch(workflow, /PRODUCTION_DEPLOY_ALLOWED/)
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/)
  assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/)
  assert.match(workflow, /name: Terraform format and validate[\s\S]*run: pnpm run infra:check/)
  assert.match(workflow, /build-production:[\s\S]*needs: \[verify\]/)
  assert.match(workflow, /build-production:[\s\S]*actions\/upload-artifact@[0-9a-f]{40}/)
  assert.match(workflow, /production-artifacts\.mjs ci package admin notifier ops/)
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf('\n  build-production:'), workflow.indexOf('\n  deploy:')),
    /id-token:\s*write|environment:\s*production|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/,
  )
  const ordered = [
    'Verify R2 backup bucket privacy',
    'Deploy notifier',
    'Apply admin remote migrations',
    'Deploy admin',
    'Deploy ops',
  ].map((step) => workflow.indexOf(`- name: ${step}`))
  assert.ok(ordered.every((position) => position >= 0))
  assert.deepEqual(
    [...ordered].sort((a, b) => a - b),
    ordered,
  )
  assert.match(
    workflow.slice(workflow.indexOf('\n  deploy:')),
    /actions\/download-artifact@[0-9a-f]{40}/,
  )
  assert.match(
    workflow.slice(workflow.indexOf('\n  deploy:')),
    /production-artifacts\.mjs ci install admin notifier ops/,
  )
  assert.match(
    workflow,
    /Verify GitHub production environment policy[\s\S]*check-github-production-environment\.mjs/,
  )
  assert.match(workflow, /production-service\.mjs admin remote-secrets/)
  assert.match(workflow, /Capture trusted production tool paths[\s\S]*realpath[\s\S]*stat -c/)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\n  deploy:')), /require-github-verify\.mjs/)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\n  deploy:')), /run build/)
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf('\n  deploy:')),
    /(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+(?:deploy|db:migrate:remote)\b/,
  )
  assert.doesNotMatch(workflow, /cloudflare\/wrangler-action@/)
  assert.doesNotMatch(workflow, /exec wrangler (?:deploy|d1 migrations apply)/)
  assert.match(workflow, /production-service\.mjs admin migrate/)
  assert.match(workflow, /production-service\.mjs notifier deploy/)
})

test('production write entry points are CI-only and cannot be reached through Make/package lifecycle', async () => {
  assert.match(
    await readFile(join(root, 'rust-toolchain.toml'), 'utf8'),
    /channel = "1\.88\.0"[\s\S]*components = \["rustfmt", "clippy"\]/,
  )
  const makefile = await readFile(join(root, 'Makefile'), 'utf8')
  assert.match(makefile, /^lint:\n\tpnpm run lint$/m)
  assert.doesNotMatch(makefile, /^deploy\/(?:admin|notifier|ops):/m)
  assert.doesNotMatch(makefile, /^db\/migrate\/remote:/m)

  for (const packagePath of [
    'services/admin/package.json',
    'services/notifier/package.json',
    'services/ops/package.json',
  ]) {
    const packageJson = JSON.parse(await readFile(join(root, packagePath), 'utf8'))
    assert.equal(packageJson.scripts.deploy, undefined)
    assert.equal(packageJson.scripts['db:migrate:remote'], undefined)
    assert.equal(packageJson.scripts['db:seed:remote'], undefined)
  }

  const productionDeploy = await readFile(join(root, 'scripts/production-deploy.mjs'), 'utf8')
  assert.match(productionDeploy, /require-production-deploy\.mjs/)
  assert.match(productionDeploy, /check-production-config\.mjs/)
  assert.match(productionDeploy, /check-production-secrets\.mjs/)
  assert.match(productionDeploy, /forbiddenProductionDeployArgs/)
  const productionSecretProvisioner = await readFile(
    join(root, 'scripts/put-production-secret.mjs'),
    'utf8',
  )
  assert.match(productionSecretProvisioner, /local production secret writes are disabled/)
  assert.doesNotMatch(productionSecretProvisioner, /runProductionWrangler/)
  assert.doesNotMatch(productionSecretProvisioner, /productionCloudflareEnvironment/)
  const bootstrapWorkflow = await readFile(
    join(root, '.github/workflows/production-bootstrap.yml'),
    'utf8',
  )
  assert.match(bootstrapWorkflow, /workflow_dispatch:/)
  assert.match(
    bootstrapWorkflow,
    /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true/,
  )
  assert.match(bootstrapWorkflow, /environment:\s*production/)
  assert.match(bootstrapWorkflow, /require-production-bootstrap\.mjs/)
  assert.match(bootstrapWorkflow, /build-production:[\s\S]*needs: \[build-production\]/)
  assert.match(
    bootstrapWorkflow,
    /build-production:[\s\S]*production-artifacts\.mjs bootstrap package/,
  )
  assert.match(bootstrapWorkflow, /bootstrap:[\s\S]*actions\/download-artifact@[0-9a-f]{40}/)
  assert.match(bootstrapWorkflow, /bootstrap:[\s\S]*production-artifacts\.mjs bootstrap install/)
  assert.doesNotMatch(
    bootstrapWorkflow.slice(
      bootstrapWorkflow.indexOf('\n  build-production:'),
      bootstrapWorkflow.indexOf('\n  bootstrap:'),
    ),
    /id-token:\s*write|environment:\s*production|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/,
  )
  assert.match(bootstrapWorkflow, /production-service\.mjs admin bootstrap/)
  assert.match(bootstrapWorkflow, /production-service\.mjs admin remote-secrets-bootstrap/)
  assert.match(
    bootstrapWorkflow,
    /Capture trusted production tool paths[\s\S]*realpath[\s\S]*stat -c/,
  )
  assert.match(bootstrapWorkflow, /DOMAIN_SERVICE.*\{0,62\}/)
  assert.match(bootstrapWorkflow, /published development\/template value|dev-auth-pepper-change-me/)
  assert.match(bootstrapWorkflow, /openssl pkey -pubout/)
  assert.doesNotMatch(
    bootstrapWorkflow.slice(bootstrapWorkflow.indexOf('\n  bootstrap:')),
    /put-production-secret\.mjs[\s\S]*--bootstrap/,
  )
  assert.doesNotMatch(
    bootstrapWorkflow.slice(bootstrapWorkflow.indexOf('\n  bootstrap:')),
    /(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+(?:deploy|db:migrate:remote)\b/,
  )
  assert.match(bootstrapWorkflow, /persist-credentials:\s*false/)
  assert.match(bootstrapWorkflow, /DOMAIN_SERVICE:\s*\$\{\{\s*inputs\.domain_service\s*\}\}/)
  assert.equal(
    bootstrapWorkflow.match(/production-service\.mjs "\$DOMAIN_SERVICE" guard-domain/g)?.length,
    2,
  )
  const restoreScript = await readFile(join(root, 'scripts/restore-d1.mjs'), 'utf8')
  assert.match(restoreScript, /require-production-provisioning\.mjs/)

  const adminPackage = JSON.parse(await readFile(join(root, 'services/admin/package.json'), 'utf8'))
  assert.equal(adminPackage.scripts['db:migrate:remote'], undefined)
  assert.equal(adminPackage.scripts['db:seed:remote'], undefined)
  const boundaryChecker = await readFile(join(root, 'scripts/check-deploy-boundary.mjs'), 'utf8')
  assert.match(boundaryChecker, /db:migrate:remote/)
  assert.match(boundaryChecker, /db:seed:remote/)
  assert.match(boundaryChecker, /require-production-deploy\.mjs/)
  assert.match(boundaryChecker, /production-migrate/)
  assert.match(await readFile(join(root, 'package.json'), 'utf8'), /"infra:check"/)
  assert.match(await readFile(join(root, 'Makefile'), 'utf8'), /infra\/check/)
  assert.match(
    await readFile(join(root, 'services/admin/seed.mjs'), 'utf8'),
    /require-production-provisioning\.mjs/,
  )
  assert.match(
    await readFile(join(root, 'services/admin/seed.mjs'), 'utf8'),
    /try\s*\{[\s\S]*?rmSync\(sqlDir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/,
  )
  assert.match(
    await readFile(join(root, 'services/admin/seed.mjs'), 'utf8'),
    /validateRemoteSeedInput/,
  )
  assert.match(
    await readFile(join(root, 'services/admin/seed.mjs'), 'utf8'),
    /env: productionStaticEnvironment\(process\.env\)[\s\S]*?childEnv = productionEnvironment\(process\.env\)[\s\S]*?for \(const name of \['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'AUTH_PEPPER'\]\) delete childEnv/,
  )

  const requiredSecretNames = {
    'services/admin/wrangler.jsonc': [
      'DOMAIN_TO_ADMIN_KEY',
      'ADMIN_TO_NOTIFIER_KEY',
      'JWT_PRIVATE_KEY',
      'JWT_PUBLIC_KEY',
      'AUTH_PEPPER',
    ],
    'services/example_service/wrangler.jsonc': [
      'ADMIN_TO_EXAMPLE_SERVICE_KEY',
      'DOMAIN_TO_ADMIN_KEY',
      'DOMAIN_TO_NOTIFIER_KEY',
      'JWT_PUBLIC_KEY',
    ],
    'services/notifier/wrangler.jsonc': [
      'ADMIN_TO_NOTIFIER_KEY',
      'DOMAIN_TO_NOTIFIER_KEY',
      'OPS_TO_NOTIFIER_KEY',
      'RESEND_API_KEY',
    ],
    'services/ops/wrangler.jsonc': [
      'OPS_TO_NOTIFIER_KEY',
      'D1_EXPORT_API_TOKEN',
      'R2_POLICY_CHECK_API_TOKEN',
    ],
  }
  for (const configPath of [
    'services/admin/wrangler.jsonc',
    'services/example_service/wrangler.jsonc',
  ]) {
    const config = await readFile(join(root, configPath), 'utf8')
    assert.match(config, /"AUTH_DEV_GRANT"\s*:\s*"false"/)
  }
  for (const configPath of [
    'services/admin/wrangler.jsonc',
    'services/example_service/wrangler.jsonc',
  ]) {
    const config = await readFile(join(root, configPath), 'utf8')
    const vars = config.match(/"vars"\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? ''
    assert.doesNotMatch(vars, /"AUTH_DEV_PRIVATE_KEY"/)
  }
  for (const [configPath, names] of Object.entries(requiredSecretNames)) {
    const source = await readFile(join(root, configPath), 'utf8')
    const required = source.match(/"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]*)\]/s)?.[1] ?? ''
    for (const name of names) assert.match(required, new RegExp(`"${name}"`))
    if (configPath === 'services/example_service/wrangler.jsonc') {
      assert.doesNotMatch(required, /"JWT_PRIVATE_KEY"/)
    }
    assert.doesNotMatch(required, /"INTERNAL_KEY"/)
  }
  assert.match(
    await readFile(join(root, 'services/notifier/wrangler.jsonc'), 'utf8'),
    /"INVITE_BASE_URL"\s*:/,
  )

  const wiring = {
    'services/admin/src/worker/index.ts': [
      /internalAuth[\s\S]*?DOMAIN_TO_ADMIN_KEY/,
      /sendNotification\(env\.NOTIFIER,\s*env\.ADMIN_TO_NOTIFIER_KEY/,
    ],
    'services/admin/src/worker/sync.ts': [/x-internal-key['"]:\s*env\.key/],
    'services/example_service/src/worker/index.ts': [
      /internalAuth[\s\S]*?ADMIN_TO_EXAMPLE_SERVICE_KEY/,
      /sendNotification\(c\.env\.NOTIFIER,\s*c\.env\.DOMAIN_TO_NOTIFIER_KEY/,
    ],
    'services/notifier/src/index.ts': [
      /ADMIN_TO_NOTIFIER_KEY[\s\S]*?DOMAIN_TO_NOTIFIER_KEY[\s\S]*?OPS_TO_NOTIFIER_KEY/,
    ],
    'services/ops/src/index.ts': [/sendNotification\(env\.NOTIFIER,\s*env\.OPS_TO_NOTIFIER_KEY/],
  }
  for (const [path, patterns] of Object.entries(wiring)) {
    const source = await readFile(join(root, path), 'utf8')
    for (const pattern of patterns) assert.match(source, pattern, path)
  }
  const domainBindings = {
    BOOKING: { fetch() {} },
    ADMIN_TO_BOOKING_KEY: 'booking-key',
    INVENTORY: { fetch() {} },
    ADMIN_TO_INVENTORY_KEY: 'inventory-key',
  }
  assert.deepEqual(
    resolveDomainSyncIdentity(domainBindings, {
      directory: 'booking',
      binding: 'BOOKING',
      secret: 'ADMIN_TO_BOOKING_KEY',
    }),
    { directory: 'booking', binding: domainBindings.BOOKING, key: 'booking-key' },
  )
  assert.deepEqual(
    resolveDomainSyncIdentity(domainBindings, {
      directory: 'inventory',
      binding: 'INVENTORY',
      secret: 'ADMIN_TO_INVENTORY_KEY',
    }),
    { directory: 'inventory', binding: domainBindings.INVENTORY, key: 'inventory-key' },
  )

  const examplePackage = JSON.parse(
    await readFile(join(root, 'services/example_service/package.json'), 'utf8'),
  )
  assert.equal(examplePackage.scripts.deploy, undefined)
  assert.equal(examplePackage.scripts['db:migrate:remote'], undefined)
})

test('root agent instructions keep service registration inside the CI-only production boundary', async () => {
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
  assert.match(agents, /DEV_ALL_SERVICES/)
  assert.match(agents, /root `package\.json` の test chain/)
  assert.match(agents, /e2e matrix/)
  assert.match(agents, /ordered protected-production deploy chain/)
  assert.doesNotMatch(agents, /DEPLOYABLE_SERVICES|make deploy\/<service>/)
})

test('manual artifact workflows do not receive Cloudflare credentials', async () => {
  for (const service of (await loadServiceCatalog(root)).filter((entry) => entry.native)) {
    const workflow = await readFile(join(root, service.nativeWorkflow), 'utf8')
    assert.deepEqual(inspectNativeWorkflowPolicy(service.nativeWorkflow, workflow, service), [])
    assert.match(workflow, /workflow_dispatch:/)
    assert.doesNotMatch(workflow, /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/)
    assert.doesNotMatch(workflow, /wrangler\s+deploy/)
    assert.match(
      workflow,
      new RegExp(
        `\\$\\{\\{ steps\\.trusted-node\\.outputs\\.path \\}\\} scripts/native-workflow\\.mjs ${service.directory} boundary`,
      ),
    )
    assert.match(
      workflow,
      new RegExp(
        `\\$\\{\\{ steps\\.trusted-node\\.outputs\\.path \\}\\} scripts/native-workflow\\.mjs ${service.directory} verify-`,
      ),
    )
    assert.match(workflow, /ANDROID_PLATFORM_API:\s*35/)
    assert.match(workflow, /ANDROID_NDK_VERSION:\s*27\.2\.12479018/)
    assert.match(workflow, /XCODEGEN_VERSION:\s*2\.46\.0/)
    assert.doesNotMatch(workflow, /sort -V\s*\|\s*tail -1/)
    assert.doesNotMatch(workflow, /(?:build:tauri|tauri\s+(?:build|ios|android))/)
  }
})

function workflowStep(workflow, name) {
  const start = workflow.indexOf(`- name: ${name}`)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)
  const next = workflow.indexOf('\n      - name:', start + 1)
  assert.notEqual(next, -1, `workflow step has no following boundary: ${name}`)
  return workflow.slice(start, next)
}

test('regular verify runs Rust checks for exactly the native service manifests', async () => {
  const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')
  const rustChecks = workflowStep(workflow, 'Rust format and Tauri unit tests')
  assert.match(rustChecks, /node scripts\/service-catalog\.mjs native-manifests/)
  assert.match(rustChecks, /while IFS= read -r manifest/)
  assert.match(rustChecks, /cargo fmt --check --manifest-path "\$manifest"/)
  assert.match(rustChecks, /cargo test --locked --manifest-path "\$manifest"/)
  assert.match(rustChecks, /cargo clippy --all-targets --manifest-path "\$manifest" -- -D warnings/)
  assert.doesNotMatch(rustChecks, /services\/[a-z0-9_]+\/src-tauri\/Cargo\.toml/)
  assert.doesNotMatch(rustChecks, /(?:@app\/)?example_service|services\/example_service\/src-tauri/)
})

test('native artifact workflows exactly match catalog native services', async () => {
  const catalog = await loadServiceCatalog(root)
  const nativeServices = catalog.filter((service) => service.native)
  assert.equal(
    new Set(nativeServices.map((service) => service.nativeWorkflow)).size,
    nativeServices.length,
  )
  for (const service of nativeServices) {
    const workflow = await readFile(join(root, service.nativeWorkflow), 'utf8')
    assert.match(
      workflow,
      new RegExp(
        `\\$\\{\\{ steps\\.trusted-node\\.outputs\\.path \\}\\} scripts/native-workflow\\.mjs ${service.directory} (?:boundary|build-)`,
      ),
    )
  }
  const webServices = catalog.filter((service) => !service.native)
  for (const service of webServices) {
    for (const nativeService of nativeServices) {
      const workflow = await readFile(join(root, nativeService.nativeWorkflow), 'utf8')
      assert.doesNotMatch(workflow, new RegExp(`native-workflow\\.mjs ${service.directory} `))
    }
  }
})

function assertNoWebTemplateNativeMakefileReference(source) {
  assert.doesNotMatch(source, /^\S*example_service\S*tauri\S*:/m)
  assert.doesNotMatch(source, /@app\/example_service\b[^\n]*\b(?:tauri|build:tauri)\b/)
  assert.doesNotMatch(source, /services\/example_service\/src-tauri/)
}

test('Makefile excludes Web-template native commands without rejecting its Web target', async () => {
  const webOnlyTarget = 'dev/example_service:\n\tpnpm --filter @app/example_service dev\n'
  assert.doesNotThrow(() => assertNoWebTemplateNativeMakefileReference(webOnlyTarget))

  const makefile = await readFile(join(root, 'Makefile'), 'utf8')
  assertNoWebTemplateNativeMakefileReference(makefile)
  assert.match(makefile, /^dev\/%\/tauri:/m)
  assert.match(makefile, /^build\/%\/tauri:/m)
  assert.match(makefile, /run-native-service\.mjs (?:dev|build)/)
})

test('an additional catalog native service needs no Make or deploy-test hard-code', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'additional-native-'))
  const service = {
    directory: 'booking',
    package: '@app/booking',
    templateKind: 'tauri',
    deployable: false,
    native: true,
    nativeWorkflow: '.github/workflows/booking-native.yml',
  }
  try {
    await mkdir(join(fixture, 'services/booking/src/web'), { recursive: true })
    await mkdir(join(fixture, '.github/workflows'), { recursive: true })
    await writeFile(
      join(fixture, 'service-catalog.json'),
      `${JSON.stringify({ services: [service] })}\n`,
    )
    await writeFile(
      join(fixture, 'services/booking/package.json'),
      `${JSON.stringify({
        name: '@app/booking',
        scripts: {
          'build:tauri': 'node ../../scripts/native-workflow.mjs package build',
          tauri: 'node ../../scripts/native-workflow.mjs package tauri',
        },
      })}\n`,
    )
    await writeFile(join(fixture, 'services/booking/src/web/App.tsx'), 'export {}\n')
    await writeFile(join(fixture, 'Makefile'), await readFile(join(root, 'Makefile'), 'utf8'))
    const referenceWorkflow = await readFile(
      join(root, '.github/workflows/example-tauri-build.yml'),
      'utf8',
    )
    await writeFile(
      join(fixture, service.nativeWorkflow),
      referenceWorkflow
        .replaceAll('example_tauri_service', 'booking')
        .replaceAll('example-tauri-service', 'booking'),
    )
    const result = await validateServiceCatalog(fixture)
    assert.deepEqual(result.violations, [])
    const make = spawnSync('make', ['-n', 'build/booking/tauri'], {
      cwd: fixture,
      encoding: 'utf8',
    })
    assert.equal(make.status, 0, make.stderr)
    assert.match(make.stdout, /run-native-service\.mjs build ['"]?booking/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('every GitHub Action reference is pinned to a full commit SHA', async () => {
  const workflowRoot = join(root, '.github/workflows')
  const entries = await (await import('node:fs/promises')).readdir(workflowRoot)
  for (const workflowPath of entries.filter(
    (path) => path.endsWith('.yml') || path.endsWith('.yaml'),
  )) {
    const source = await readFile(join(workflowRoot, workflowPath), 'utf8')
    for (const line of source.split('\n').filter((line) => /\buses:\s*/.test(line))) {
      assert.match(line, /\buses:\s*[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/i, `${workflowPath}: ${line}`)
    }
  }
})

test('only the two reviewed production workflows may carry production capabilities', async () => {
  const workflowRoot = join(root, '.github/workflows')
  const nativeWorkflowNames = (await loadServiceCatalog(root))
    .filter((service) => service.native)
    .map((service) => service.nativeWorkflow.replace('.github/workflows/', ''))
  for (const workflowPath of ['agent-compat.yml', ...nativeWorkflowNames]) {
    const source = await readFile(join(workflowRoot, workflowPath), 'utf8')
    assert.doesNotMatch(source, /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/)
    assert.doesNotMatch(source, /\bwrangler\s+(?:deploy|d1|r2)\b/)
    assert.doesNotMatch(source, /id-token:\s*write/)
  }
  const policy = await readFile(join(root, 'scripts/workflow-policy.mjs'), 'utf8')
  assert.match(policy, /\['ci\.yml', 'deploy'\]/)
  assert.match(policy, /\['production-bootstrap\.yml', 'bootstrap'\]/)
  assert.match(policy, /secrets\\\.PRODUCTION_/)
})
