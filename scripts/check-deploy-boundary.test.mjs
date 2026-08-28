import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()

test('production CI deploy is push-only on protected main', async () => {
  const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')
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
  assert.match(workflow, /verify-worker-artifact\.mjs[\s\S]*production-worker-manifest\.json/)
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
    /verify-worker-artifact\.mjs[\s\S]*--archive[\s\S]*--install-root/,
  )
  assert.match(
    workflow,
    /Verify GitHub production environment policy[\s\S]*check-github-production-environment\.mjs/,
  )
  assert.match(
    workflow,
    /Verify remote production secret names before any write[\s\S]*workers\/scripts[\s\S]*JWT_PRIVATE_KEY/,
  )
  assert.match(workflow, /Capture trusted production tool paths[\s\S]*realpath[\s\S]*stat -c/)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\n  deploy:')), /require-github-verify\.mjs/)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\n  deploy:')), /run build/)
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf('\n  deploy:')),
    /(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+(?:deploy|db:migrate:remote)\b/,
  )
  assert.doesNotMatch(workflow, /cloudflare\/wrangler-action@/)
  assert.match(workflow, /exec wrangler deploy dist\/index\.js --no-bundle/)
  assert.match(workflow, /exec wrangler d1 migrations apply DB --remote/)
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
  assert.match(bootstrapWorkflow, /build-production:[\s\S]*verify-worker-artifact\.mjs/)
  assert.match(bootstrapWorkflow, /bootstrap:[\s\S]*actions\/download-artifact@[0-9a-f]{40}/)
  assert.match(
    bootstrapWorkflow,
    /bootstrap:[\s\S]*verify-worker-artifact\.mjs[\s\S]*--archive[\s\S]*--install-root/,
  )
  assert.doesNotMatch(
    bootstrapWorkflow.slice(
      bootstrapWorkflow.indexOf('\n  build-production:'),
      bootstrapWorkflow.indexOf('\n  bootstrap:'),
    ),
    /id-token:\s*write|environment:\s*production|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/,
  )
  assert.match(
    bootstrapWorkflow,
    /Bootstrap production Workers with fixed secret bundles[\s\S]*--secrets-file/,
  )
  assert.match(
    bootstrapWorkflow,
    /Verify remote production secret names before any write[\s\S]*workers\/scripts[\s\S]*JWT_PRIVATE_KEY/,
  )
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
  assert.match(
    bootstrapWorkflow,
    /\[\[\s*!\s*"\$DOMAIN_SERVICE"\s*=~\s*\^\[a-z\]\[a-z0-9_\]\*\$|\|\|\s*"\$DOMAIN_SERVICE"\s*==\s*admin/,
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
      'ADMIN_TO_EXAMPLE_SERVICE_KEY',
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
    'services/admin/src/worker/sync.ts': [
      /x-internal-key['"]:\s*env\.ADMIN_TO_EXAMPLE_SERVICE_KEY/,
    ],
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

  const examplePackage = JSON.parse(
    await readFile(join(root, 'services/example_service/package.json'), 'utf8'),
  )
  assert.equal(examplePackage.scripts.deploy, undefined)
  assert.equal(examplePackage.scripts['db:migrate:remote'], undefined)
})

test('manual artifact workflows do not receive Cloudflare credentials', async () => {
  for (const workflowPath of [
    '.github/workflows/example-tauri-build.yml',
    '.github/workflows/tauri-build.yml',
  ]) {
    const workflow = await readFile(join(root, workflowPath), 'utf8')
    assert.match(workflow, /workflow_dispatch:/)
    assert.doesNotMatch(workflow, /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/)
    assert.doesNotMatch(workflow, /wrangler\s+deploy/)
    assert.match(workflow, /check-tauri-boundary\.mjs/)
    assert.match(workflow, /check-tauri-artifact\.mjs/)
    assert.match(workflow, /ANDROID_PLATFORM_API:\s*35/)
    assert.match(workflow, /ANDROID_NDK_VERSION:\s*27\.2\.12479018/)
    assert.match(workflow, /XCODEGEN_VERSION:\s*2\.46\.0/)
    assert.doesNotMatch(workflow, /sort -V\s*\|\s*tail -1/)
    assert.match(workflow, /test "\$\(xcodegen --version\)" = "Version: \$\{XCODEGEN_VERSION\}"/)
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
  for (const workflowPath of ['agent-compat.yml', 'tauri-build.yml', 'example-tauri-build.yml']) {
    const source = await readFile(join(workflowRoot, workflowPath), 'utf8')
    assert.doesNotMatch(source, /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/)
    assert.doesNotMatch(source, /\bwrangler\s+(?:deploy|d1|r2)\b/)
    assert.doesNotMatch(source, /id-token:\s*write/)
  }
  const boundary = await readFile(join(root, 'scripts/check-deploy-boundary.mjs'), 'utf8')
  assert.match(boundary, /credentialedProductionWorkflows/)
  assert.match(boundary, /secrets\\\.PRODUCTION_/)
})
