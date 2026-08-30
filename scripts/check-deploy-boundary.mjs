#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveValues, parseJsonc } from './check-production-config.mjs'
import { isProductionDomainAuthReady } from './require-production-domain-auth.mjs'
import { loadServiceRepositoryCatalog } from './service-catalog.mjs'
import { inspectWorkflowPolicy } from './workflow-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const violations = []
const credentialedProductionWorkflows = new Set(['ci.yml', 'production-bootstrap.yml'])
const serviceCatalog = await loadServiceRepositoryCatalog(root)

export function isFixedProductionDeployScript(script, service) {
  return script === `node ../../scripts/production-deploy.mjs ${service}`
}

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) violations.push(message)
}

const rustToolchain = await readFile(join(root, 'rust-toolchain.toml'), 'utf8')
requireMatch(
  rustToolchain,
  /channel\s*=\s*"1\.88\.0"[\s\S]*components\s*=\s*\["rustfmt",\s*"clippy"\]/,
  'Rust native builds must use the reviewed pinned toolchain with format and lint components',
)

function adminToDomainSecretName(service) {
  if (typeof service !== 'string') return null
  const suffix = service.replaceAll('-', '_').toUpperCase()
  return /^[A-Z][A-Z0-9_]*$/.test(suffix) ? `ADMIN_TO_${suffix}_KEY` : null
}

function workflowStepBlock(step) {
  const start = workflow.indexOf(`- name: ${step}`)
  if (start < 0) return ''
  const end = workflow.indexOf('\n      - ', start + 1)
  return workflow.slice(start, end < 0 ? undefined : end)
}

const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')
requireMatch(
  workflow,
  /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true/,
  'ci deploy must require a push to protected main',
)
requireMatch(
  workflow,
  /name: Require main branch protection for production boundary[\s\S]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'[\s\S]*?run: test "\$\{\{ github\.ref_protected \}\}" = "true"/,
  'ci must fail closed when main branch protection is missing',
)
requireMatch(workflow, /environment:\s*production/, 'ci deploy must use the production environment')
if (/PRODUCTION_DEPLOY_ALLOWED/.test(workflow)) {
  violations.push('ci deploy must not trust a caller-provided production allow marker')
}
requireMatch(
  workflow,
  /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true/,
  'ci deploy must expose the same protected-main context checked by the package guard',
)
requireMatch(
  workflow,
  /CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/,
  'ci deploy must read the Cloudflare API token from an environment secret',
)
requireMatch(
  workflow,
  /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/,
  'ci deploy must read the Cloudflare account id from an environment secret',
)

const orderedDeploySteps = [
  'Verify R2 backup bucket privacy',
  'Deploy notifier',
  'Apply admin remote migrations',
  'Deploy admin',
  'Deploy ops',
]
let previousStep = -1
for (const step of orderedDeploySteps) {
  const position = workflow.indexOf(`- name: ${step}`)
  if (position < 0 || position <= previousStep) {
    violations.push(`ci deploy steps must remain a single ordered chain: ${step}`)
  }
  previousStep = position
}
const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'))
const buildJobStart = workflow.indexOf('\n  build-production:')
const buildJobEnd = workflow.indexOf('\n  deploy:', buildJobStart)
const buildJob = workflow.slice(buildJobStart, buildJobEnd < 0 ? undefined : buildJobEnd)
requireMatch(
  buildJob,
  /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true/,
  'production build must require a push to protected main',
)
requireMatch(buildJob, /needs:\s*\[verify\]/, 'production build must depend on verify')
requireMatch(
  buildJob,
  /actions\/upload-artifact@[0-9a-f]{40}/,
  'production build must publish a pinned artifact for the deploy job',
)
requireMatch(
  buildJob,
  /production-worker-bundles\.tar\.gz/,
  'production build must publish the reviewed Worker bundle archive',
)
requireMatch(
  buildJob,
  /verify-worker-artifact\.mjs[\s\S]*?production-worker-manifest\.json/,
  'production build must verify and manifest every Worker output',
)
if (
  /id-token:\s*write|environment:\s*production|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/.test(buildJob)
) {
  violations.push('production build must not receive production environment capabilities')
}
if (/max-parallel\s*:\s*1|\n\s*matrix:/.test(deployJob)) {
  violations.push('ci production deploy must not rely on matrix ordering')
}
if (/id-token:\s*write|require-github-production-attestation\.mjs/.test(deployJob)) {
  violations.push('ci production deploy must not mint or consume an unnecessary OIDC token')
}
requireMatch(
  deployJob,
  /Verify GitHub production environment policy[\s\S]*?check-github-production-environment\.mjs/,
  'ci production deploy must verify the mutable GitHub production environment policy',
)
requireMatch(
  deployJob,
  /Verify GitHub production environment policy[\s\S]*?GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
  'ci production deploy environment check must use the job GitHub token',
)
requireMatch(
  deployJob,
  /Resolve reviewed production resource identities before credentials[\s\S]*?production-resource-identities\.mjs/,
  'ci production deploy must resolve reviewed resource identities before credentials',
)
requireMatch(
  deployJob,
  /Verify Cloudflare account and D1 resource identities[\s\S]*?d1\/database/,
  'ci production deploy must verify the actual Cloudflare account and D1 identities',
)
requireMatch(
  deployJob,
  /Verify reviewed production service configs before credentials[\s\S]*?check-production-config\.mjs/,
  'ci production deploy must validate every reviewed Worker config before credentials',
)
requireMatch(
  deployJob,
  /Verify remote production secret names before any write[\s\S]*?workers\/scripts[\s\S]*?JWT_PRIVATE_KEY/,
  'ci production deploy must reject stale or unexpected remote secret names before writes',
)
requireMatch(
  deployJob,
  /Verify remote production secret names before any write[\s\S]*?worker_name="\$\{service\/\/_\/-\}"[\s\S]*?workers\/scripts\/\$worker_name\/secrets/,
  'ci production deploy must inspect each Worker through the reviewed Cloudflare API path',
)
requireMatch(
  deployJob,
  /Capture trusted production tool paths[\s\S]*?realpath[\s\S]*?resolved inside the checkout[\s\S]*?stat -c/,
  'ci production deploy must reject repository-controlled tool executables',
)
requireMatch(
  deployJob,
  /actions\/download-artifact@[0-9a-f]{40}/,
  'credentialed deploy must download the reviewed build artifact',
)
requireMatch(
  deployJob,
  /verify-worker-artifact\.mjs[\s\S]*?--archive[\s\S]*?--install-root/,
  'credentialed deploy must verify and install the Worker artifact before Wrangler',
)
if (/(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+build\b/.test(deployJob)) {
  violations.push('credentialed deploy must not execute a repository build script')
}
if (/(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+(?:deploy|db:migrate:remote)\b/.test(deployJob)) {
  violations.push(
    'credentialed deploy must invoke fixed Wrangler commands, not package lifecycle entry points',
  )
}

for (const workflowPath of await readdir(join(root, '.github/workflows'))) {
  if (!workflowPath.endsWith('.yml') && !workflowPath.endsWith('.yaml')) continue
  const source = await readFile(join(root, '.github/workflows', workflowPath), 'utf8')
  violations.push(...inspectWorkflowPolicy(workflowPath, source))
  const checkoutBlocks =
    source.match(/- uses:\s*actions\/checkout@[^\n]*(?:\n(?!\s*- uses:)[^\n]*)*/g) ?? []
  for (const block of checkoutBlocks) {
    if (!/persist-credentials:\s*false/.test(block)) {
      violations.push(`${workflowPath} checkout must disable persisted credentials`)
    }
  }
  if (!credentialedProductionWorkflows.has(workflowPath)) {
    if (/CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/.test(source)) {
      violations.push(`${workflowPath} must not receive production Cloudflare credentials`)
    }
    if (/\bwrangler\s+(?:deploy|d1|r2)\b/.test(source)) {
      violations.push(`${workflowPath} must not invoke raw production Wrangler commands`)
    }
    if (/id-token:\s*write/.test(source)) {
      violations.push(`${workflowPath} must not mint a production OIDC token`)
    }
  }
  if (workflowPath === 'tauri-build.yml' || workflowPath === 'example-tauri-build.yml') {
    requireMatch(
      source,
      /ANDROID_PLATFORM_API:\s*35/,
      `${workflowPath} must pin the Android platform API used by verification artifacts`,
    )
    requireMatch(
      source,
      /ANDROID_NDK_VERSION:\s*27\.2\.12479018/,
      `${workflowPath} must pin the Android NDK used by verification artifacts`,
    )
    requireMatch(
      source,
      /XCODEGEN_VERSION:\s*2\.46\.0/,
      `${workflowPath} must pin the XcodeGen version used by verification artifacts`,
    )
    if (/sort -V\s*\|\s*tail -1/.test(source)) {
      violations.push(`${workflowPath} must not select the latest Android SDK/NDK dynamically`)
    }
    requireMatch(
      source,
      /test "\$\(xcodegen --version\)" = "Version: \$\{XCODEGEN_VERSION\}"/,
      `${workflowPath} must fail if the installed XcodeGen version drifts`,
    )
    requireMatch(
      source,
      /Check pinned Rust toolchain[\s\S]*?rustc --version[\s\S]*?1\.88\.0/,
      `${workflowPath} must fail if the Rust toolchain drifts`,
    )
  }
}

const makefile = await readFile(join(root, 'Makefile'), 'utf8')
if (/^deploy\/(?:admin|notifier|ops):/m.test(makefile)) {
  violations.push('Makefile must not expose local production deploy targets')
}
if (/^db\/migrate\/remote:/m.test(makefile)) {
  violations.push('Makefile must not expose a local remote-migration target')
}

for (const packagePath of [
  'services/admin/package.json',
  'services/notifier/package.json',
  'services/ops/package.json',
]) {
  const packageJson = JSON.parse(await readFile(join(root, packagePath), 'utf8'))
  if (packageJson.scripts?.deploy) {
    violations.push(`${packagePath} must not expose a local production deploy script`)
  }
  if (packageJson.scripts?.['db:migrate:remote']) {
    violations.push(`${packagePath} must not expose a local remote migration script`)
  }
  if (packageJson.scripts?.['db:seed:remote']) {
    violations.push(`${packagePath} must not expose a local remote seed script`)
  }
  if (!/run-without-cloudflare-env\.mjs/.test(packageJson.scripts?.build ?? '')) {
    violations.push(`${packagePath} build script must scrub Cloudflare credentials`)
  }
  for (const lifecycleName of [
    'predeploy',
    'postdeploy',
    'predb:migrate:remote',
    'postdb:migrate:remote',
    'predb:seed:remote',
    'postdb:seed:remote',
  ]) {
    if (packageJson.scripts?.[lifecycleName]) {
      violations.push(`${packagePath} must not define the credentialed ${lifecycleName} hook`)
    }
  }
}
for (const packagePath of [
  'services/admin/package.json',
  'services/example_service/package.json',
  'services/example_tauri_service/package.json',
]) {
  const packageJson = JSON.parse(await readFile(join(root, packagePath), 'utf8'))
  if (!/check-tauri-artifact\.mjs\s+dist\/client/.test(packageJson.scripts?.build ?? '')) {
    violations.push(`${packagePath} web build must scan dist/client for secret markers`)
  }
}
for (const packagePath of [
  'services/admin/package.json',
  'services/example_tauri_service/package.json',
]) {
  const packageJson = JSON.parse(await readFile(join(root, packagePath), 'utf8'))
  if (!/check-tauri-artifact\.mjs\s+dist\/tauri/.test(packageJson.scripts?.['build:tauri'] ?? '')) {
    violations.push(`${packagePath} Tauri build must scan dist/tauri for secret markers`)
  }
}

const productionDeploy = await readFile(join(root, 'scripts/production-deploy.mjs'), 'utf8')
for (const required of [
  'require-production-deploy.mjs',
  'check-production-config.mjs',
  'check-production-secrets.mjs',
  'production-environment.mjs',
  'require-production-domain-auth.mjs',
  'verify-worker-artifact.mjs',
  'production-wrangler.mjs',
]) {
  if (!productionDeploy.includes(required)) {
    violations.push(`production deploy wrapper is missing ${required}`)
  }
}
if (!productionDeploy.includes('check-r2-private.mjs')) {
  violations.push('production ops deploy must verify that the R2 backup bucket is private')
}
const deployGuard = await readFile(join(root, 'scripts/require-production-deploy.mjs'), 'utf8')
if (/require-github-production-attestation\.mjs|ACTIONS_ID_TOKEN_REQUEST_/.test(deployGuard)) {
  violations.push('production deploy guard must not depend on an unnecessary OIDC token')
}

const productionSecretProvisioner = await readFile(
  join(root, 'scripts/put-production-secret.mjs'),
  'utf8',
)
requireMatch(
  productionSecretProvisioner,
  /local production secret writes are disabled[\s\S]*protected production workflow/,
  'local production secret provisioning must be disabled in favor of a protected workflow',
)
if (
  /runProductionWrangler|productionCloudflareEnvironment|secret\s+put/.test(
    productionSecretProvisioner,
  )
) {
  violations.push('local production secret provisioning must not contain a Cloudflare write path')
}
const productionMigration = await readFile(join(root, 'scripts/production-migrate.mjs'), 'utf8')
requireMatch(
  productionMigration,
  /require-production-domain-auth\.mjs/,
  'production migration wrapper must block copied domains without reviewed production auth',
)

const bootstrapWorkflow = await readFile(
  join(root, '.github/workflows/production-bootstrap.yml'),
  'utf8',
)
requireMatch(
  bootstrapWorkflow,
  /Verify R2 backup bucket privacy before provisioning[\s\S]*api\.cloudflare\.com[\s\S]*\/domains/,
  'production bootstrap must verify R2 privacy before provisioning without repository code',
)
const bootstrapBuildStart = bootstrapWorkflow.indexOf('\n  build-production:')
const bootstrapJobStart = bootstrapWorkflow.indexOf('\n  bootstrap:')
const bootstrapBuildJob = bootstrapWorkflow.slice(
  bootstrapBuildStart,
  bootstrapJobStart < 0 ? undefined : bootstrapJobStart,
)
requireMatch(
  bootstrapBuildJob,
  /if:\s*github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true/,
  'bootstrap build must require a workflow dispatch on protected main',
)
requireMatch(
  bootstrapBuildJob,
  /actions\/upload-artifact@[0-9a-f]{40}/,
  'bootstrap build must publish a pinned Worker artifact',
)
requireMatch(
  bootstrapBuildJob,
  /verify-worker-artifact\.mjs[\s\S]*?production-worker-manifest\.json/,
  'bootstrap build must verify and manifest every Worker output',
)
requireMatch(
  bootstrapBuildJob,
  /require-production-domain-auth\.mjs/,
  'bootstrap build must block copied domains until production auth is reviewed',
)
if (
  /id-token:\s*write|environment:\s*production|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/.test(
    bootstrapBuildJob,
  )
) {
  violations.push('bootstrap build must not receive production environment capabilities')
}
const bootstrapJob = bootstrapWorkflow.slice(bootstrapJobStart)
requireMatch(
  bootstrapJob,
  /needs:\s*\[build-production\]/,
  'bootstrap must depend on its credentialless build',
)
requireMatch(
  bootstrapJob,
  /actions\/download-artifact@[0-9a-f]{40}/,
  'bootstrap must download the reviewed Worker artifact',
)
requireMatch(
  bootstrapJob,
  /verify-worker-artifact\.mjs[\s\S]*?--archive[\s\S]*?--install-root/,
  'bootstrap must verify and install the Worker artifact before credentials are used',
)
if (/(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+build\b/.test(bootstrapJob)) {
  violations.push('credentialed bootstrap must not execute a repository build script')
}
if (/(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+(?:deploy|db:migrate:remote)\b/.test(bootstrapJob)) {
  violations.push(
    'credentialed bootstrap must invoke fixed Wrangler commands, not package lifecycle entry points',
  )
}
requireMatch(
  bootstrapWorkflow,
  /workflow_dispatch:/,
  'production secret bootstrap must be manually triggered',
)
requireMatch(
  bootstrapWorkflow,
  /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true/,
  'production secret bootstrap must require protected main workflow_dispatch',
)
requireMatch(
  bootstrapWorkflow,
  /environment:\s*production/,
  'production secret bootstrap must use the production environment',
)
requireMatch(
  bootstrapWorkflow,
  /Verify GitHub production environment policy[\s\S]*?check-github-production-environment\.mjs/,
  'production bootstrap must verify the mutable GitHub production environment policy',
)
requireMatch(
  bootstrapWorkflow,
  /Resolve reviewed production resource identities before credentials[\s\S]*?production-resource-identities\.mjs/,
  'production bootstrap must resolve reviewed resource identities before credentials',
)
requireMatch(
  bootstrapWorkflow,
  /Verify reviewed production service configs before credentials[\s\S]*?check-production-config\.mjs/,
  'production bootstrap must validate every reviewed Worker config before credentials',
)
requireMatch(
  bootstrapWorkflow,
  /Verify Cloudflare account and D1 resource identities[\s\S]*?d1\/database/,
  'production bootstrap must verify the actual Cloudflare account and D1 identities',
)
requireMatch(
  bootstrapWorkflow,
  /require-production-bootstrap\.mjs/,
  'production secret bootstrap must invoke the bootstrap guard',
)
requireMatch(
  bootstrapWorkflow,
  /Bootstrap production Workers with fixed secret bundles[\s\S]*--secrets-file/,
  'production secret bootstrap must use fixed, explicitly allowlisted secret bundles',
)
requireMatch(
  bootstrapWorkflow,
  /Verify remote production secret names before any write[\s\S]*?workers\/scripts[\s\S]*?JWT_PRIVATE_KEY/,
  'production bootstrap must reject stale or unexpected remote secret names before writes',
)
requireMatch(
  bootstrapWorkflow,
  /Verify remote production secret names before any write[\s\S]*?worker_name="\$\{service\/\/_\/-\}"[\s\S]*?workers\/scripts\/\$worker_name\/secrets/,
  'production secret bootstrap must inspect each Worker through the reviewed Cloudflare API path',
)
requireMatch(
  bootstrapWorkflow,
  /Capture trusted production tool paths[\s\S]*?realpath[\s\S]*?resolved inside the checkout[\s\S]*?stat -c/,
  'production secret bootstrap must reject repository-controlled tool executables',
)
requireMatch(
  bootstrapWorkflow,
  /published development\/template value|dev-auth-pepper-change-me/,
  'production bootstrap must reject published development secret values',
)
requireMatch(
  bootstrapWorkflow,
  /at least 32 bytes/,
  'production bootstrap must reject weak opaque secret values',
)
if (/put-production-secret\.mjs[\s\S]*--bootstrap/.test(bootstrapJob)) {
  violations.push(
    'credentialed bootstrap must not execute the repository secret provisioning helper',
  )
}
if (/id-token:\s*write|require-github-production-attestation\.mjs/.test(bootstrapWorkflow)) {
  violations.push('production bootstrap must not mint or consume an unnecessary OIDC token')
}
const bootstrapGuard = await readFile(
  join(root, 'scripts/require-production-bootstrap.mjs'),
  'utf8',
)
if (/require-github-production-attestation\.mjs|ACTIONS_ID_TOKEN_REQUEST_/.test(bootstrapGuard)) {
  violations.push('production bootstrap guard must not depend on an unnecessary OIDC token')
}
requireMatch(
  bootstrapWorkflow,
  /persist-credentials:\s*false/,
  'production secret bootstrap checkout must disable persisted credentials',
)
requireMatch(
  bootstrapWorkflow,
  /DOMAIN_SERVICE:\s*\$\{\{\s*inputs\.domain_service\s*\}\}/,
  'production secret bootstrap must pass the manual input through the environment',
)
requireMatch(
  bootstrapWorkflow,
  /\[\[\s*!\s*"\$DOMAIN_SERVICE"\s*=~\s*\^\[a-z\]\[a-z0-9_\]\{0,62\}\$|\|\|\s*"\$DOMAIN_SERVICE"\s*==\s*admin/,
  'production secret bootstrap must validate the domain service before shell use',
)

const restoreScript = await readFile(join(root, 'scripts/restore-d1.mjs'), 'utf8')
for (const required of [
  'require-production-provisioning.mjs',
  'check-production-config.mjs',
  'check-production-secrets.mjs',
  'check-r2-private.mjs',
  'production-environment.mjs',
  'production-wrangler.mjs',
  'RESTORE_PRODUCTION',
]) {
  if (!restoreScript.includes(required)) {
    violations.push(`restore wrapper is missing ${required}`)
  }
}
const restoreRunbook = await readFile(join(root, 'docs/howto/restore.md'), 'utf8')
if (!/scripts\/restore-d1\.mjs/.test(restoreRunbook)) {
  violations.push('restore runbook must use the guarded restore wrapper')
}
if (/wrangler\s+(?:d1|r2)\s/.test(restoreRunbook)) {
  violations.push('restore runbook must not expose raw Wrangler restore commands')
}

const adminPackage = JSON.parse(await readFile(join(root, 'services/admin/package.json'), 'utf8'))
for (const scriptName of ['deploy', 'db:migrate:remote', 'db:seed:remote']) {
  if (adminPackage.scripts?.[scriptName]) {
    violations.push(`services/admin/package.json must not expose ${scriptName}`)
  }
}

// Remote migrations and seeds are fixed commands in the protected CI workflow.
// No package lifecycle entry point may be used as a credentialed escape hatch.
for (const serviceEntry of await readdir(join(root, 'services'), { withFileTypes: true })) {
  if (!serviceEntry.isDirectory()) continue
  const packagePath = join(root, 'services', serviceEntry.name, 'package.json')
  let packageJson
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  } catch {
    continue
  }
  for (const scriptName of ['deploy', 'db:migrate:remote', 'db:seed:remote']) {
    const script = packageJson.scripts?.[scriptName]
    if (!script) continue
    violations.push(`${packagePath} must not expose ${scriptName}; use protected CI commands`)
  }
}

const adminSeed = await readFile(join(root, 'services/admin/seed.mjs'), 'utf8')
if (!/require-production-provisioning\.mjs/.test(adminSeed)) {
  violations.push('admin remote seed must use the protected production workflow guard')
}
if (!/production-environment\.mjs/.test(adminSeed)) {
  violations.push('admin seed must scrub production process override variables')
}
if (!/ADMIN_DATABASE_ID|validateRemoteSeedDatabaseId/.test(adminSeed)) {
  violations.push('admin remote seed must execute against the reviewed D1 database id')
}
if (
  !/try\s*\{[\s\S]*?rmSync\(sqlDir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/.test(
    adminSeed,
  )
) {
  violations.push('admin seed SQL must be removed after local or remote execution')
}

for (const configPath of [
  'services/admin/wrangler.jsonc',
  'services/example_service/wrangler.jsonc',
]) {
  const source = await readFile(join(root, configPath), 'utf8')
  if (!/"AUTH_DEV_GRANT"\s*:\s*"false"/.test(source)) {
    violations.push(`${configPath} must disable AUTH_DEV_GRANT by default`)
  }
}
for (const configPath of [
  'services/admin/wrangler.jsonc',
  'services/example_service/wrangler.jsonc',
]) {
  const source = await readFile(join(root, configPath), 'utf8')
  const vars = source.match(/"vars"\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? ''
  if (/"AUTH_DEV_PRIVATE_KEY"/.test(vars)) {
    violations.push(
      `${configPath} must not declare the local-only AUTH_DEV_PRIVATE_KEY as a production var`,
    )
  }
}

const adminConfigSource = await readFile(join(root, 'services/admin/wrangler.jsonc'), 'utf8')
let configuredAdminDomainSecret = 'ADMIN_TO_EXAMPLE_SERVICE_KEY'
try {
  configuredAdminDomainSecret =
    adminToDomainSecretName(effectiveValues(parseJsonc(adminConfigSource)).adminDomainService) ??
    configuredAdminDomainSecret
} catch {
  violations.push('admin wrangler.jsonc must be valid JSONC for secret-boundary inspection')
}

const requiredSecretNames = {
  'services/admin/wrangler.jsonc': [
    'DOMAIN_TO_ADMIN_KEY',
    configuredAdminDomainSecret,
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
    'BACKUP_SIGNING_PRIVATE_KEY',
  ],
}
const notifierConfigSource = await readFile(join(root, 'services/notifier/wrangler.jsonc'), 'utf8')
if (!/"INVITE_BASE_URL"\s*:/.test(notifierConfigSource)) {
  violations.push('notifier wrangler config must declare the canonical invite origin')
}
for (const [configPath, names] of Object.entries(requiredSecretNames)) {
  const source = await readFile(join(root, configPath), 'utf8')
  const required = source.match(/"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]*)\]/s)?.[1] ?? ''
  for (const name of names) {
    if (!new RegExp(`"${name}"`).test(required)) {
      violations.push(`${configPath} must require secret ${name}`)
    }
  }
  if (
    configPath === 'services/example_service/wrangler.jsonc' &&
    /"JWT_PRIVATE_KEY"/.test(required)
  ) {
    violations.push('example_service must not require JWT_PRIVATE_KEY')
  }
  if (/("INTERNAL_KEY"|"JWT_SECRET")/.test(required)) {
    violations.push(`${configPath} must not use deprecated shared authentication secrets`)
  }
}

const bindingKeyWiring = {
  'services/admin/src/worker/index.ts': [
    [
      /internalAuth[\s\S]*?DOMAIN_TO_ADMIN_KEY/,
      'admin must guard internal routes with DOMAIN_TO_ADMIN_KEY',
    ],
    [
      /sendNotification\(env\.NOTIFIER,\s*env\.ADMIN_TO_NOTIFIER_KEY/,
      'admin must notify with ADMIN_TO_NOTIFIER_KEY',
    ],
  ],
  'services/admin/src/worker/sync.ts': [
    [
      /x-internal-key['"]:\s*env\.ADMIN_TO_EXAMPLE_SERVICE_KEY/,
      'admin sync must use ADMIN_TO_EXAMPLE_SERVICE_KEY',
    ],
  ],
  'services/example_service/src/worker/index.ts': [
    [
      /internalAuth[\s\S]*?ADMIN_TO_EXAMPLE_SERVICE_KEY/,
      'domain must guard internal routes with ADMIN_TO_EXAMPLE_SERVICE_KEY',
    ],
    [
      /sendNotification\(c\.env\.NOTIFIER,\s*c\.env\.DOMAIN_TO_NOTIFIER_KEY/,
      'domain must notify with DOMAIN_TO_NOTIFIER_KEY',
    ],
  ],
  'services/notifier/src/index.ts': [
    [
      /ADMIN_TO_NOTIFIER_KEY[\s\S]*?DOMAIN_TO_NOTIFIER_KEY[\s\S]*?OPS_TO_NOTIFIER_KEY/,
      'notifier must enumerate all caller-specific keys',
    ],
  ],
  'services/ops/src/index.ts': [
    [
      /sendNotification\(env\.NOTIFIER,\s*env\.OPS_TO_NOTIFIER_KEY/,
      'ops must notify with OPS_TO_NOTIFIER_KEY',
    ],
  ],
}
for (const [path, checks] of Object.entries(bindingKeyWiring)) {
  const source = await readFile(join(root, path), 'utf8')
  for (const [pattern, message] of checks) requireMatch(source, pattern, message)
}

for (const template of ['example_service', 'example_tauri_service']) {
  const templatePackage = JSON.parse(
    await readFile(join(root, `services/${template}/package.json`), 'utf8'),
  )
  if (templatePackage.scripts?.deploy || templatePackage.scripts?.['db:migrate:remote']) {
    violations.push(`${template} must not expose production deploy or remote migration scripts`)
  }
}

// A copied domain is production code, not a documentation-only convention.
// Make omissions fail in the repository's own boundary check before a deploy
// can be attempted: package entry points, Make, CI, admin's service binding,
// and ops' backup/health target must all be wired for the same service name.
const opsConfigSource = await readFile(join(root, 'services/ops/wrangler.jsonc'), 'utf8')
const opsSource = await readFile(join(root, 'services/ops/src/index.ts'), 'utf8')
for (const { directory: service } of serviceCatalog.services.filter(
  (candidate) => candidate.deployable && candidate.directory !== 'admin',
)) {
  const packagePath = join(root, 'services', service, 'package.json')
  const configPath = join(root, 'services', service, 'wrangler.jsonc')
  let packageJson
  let configSource
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
    configSource = await readFile(configPath, 'utf8')
  } catch {
    violations.push(`${service} must contain package.json and wrangler.jsonc`)
    continue
  }
  if (packageJson.name !== `@app/${service}`) {
    violations.push(`${service} package name must be @app/${service}`)
  }
  if (!isProductionDomainAuthReady(service, root)) {
    violations.push(
      `${service} must add the reviewed production-auth.ts middleware and test before production wiring`,
    )
  }
  for (const scriptName of ['deploy', 'db:migrate:remote', 'db:seed:remote']) {
    if (packageJson.scripts?.[scriptName]) {
      violations.push(`${service} must not expose ${scriptName}; use protected CI commands`)
    }
  }
  if (!/run-without-cloudflare-env\.mjs/.test(packageJson.scripts?.build ?? '')) {
    violations.push(`${service} build script must scrub Cloudflare credentials`)
  }
  if (
    /["'](?:JWT_PRIVATE_KEY|JWT_SECRET|INTERNAL_KEY|AUTH_DEV_PRIVATE_KEY)["']/.test(configSource)
  ) {
    violations.push(`${service} production config must never include a private/shared auth key`)
  }
  const required =
    configSource.match(/"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]*)\]/s)?.[1] ?? ''
  const domainSecret = `ADMIN_TO_${service.toUpperCase()}_KEY`
  for (const name of [
    domainSecret,
    'DOMAIN_TO_ADMIN_KEY',
    'DOMAIN_TO_NOTIFIER_KEY',
    'JWT_PUBLIC_KEY',
  ]) {
    if (!new RegExp(`"${name}"`).test(required)) {
      violations.push(`${service} production config must require secret ${name}`)
    }
  }

  if (new RegExp(`^deploy/${service}:`, 'm').test(makefile)) {
    violations.push(`Makefile must not expose local production deploy target ${service}`)
  }

  const packageName = `@app/${service}`
  const buildStep = `Build ${service} (no Cloudflare credentials)`
  const migrationStep = `Apply ${service} remote migrations`
  const deployStep = `Deploy ${service}`
  const stepPositions = [buildStep, migrationStep, deployStep].map((step) =>
    workflow.indexOf(`- name: ${step}`),
  )
  const [buildPosition, migrationPosition, deployPosition] = stepPositions
  if (
    stepPositions.some((position) => position < 0) ||
    buildPosition >= migrationPosition ||
    migrationPosition >= deployPosition
  ) {
    violations.push(
      `CI must explicitly build, migrate, and deploy copied domain ${service} in order`,
    )
  }
  const buildBlock = workflowStepBlock(buildStep)
  const migrationBlock = workflowStepBlock(migrationStep)
  const deployBlock = workflowStepBlock(deployStep)
  if (!buildBlock.includes(`pnpm --filter ${packageName} run build`)) {
    violations.push(`${service} CI build step must use the package build command`)
  }
  if (/CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/.test(buildBlock)) {
    violations.push(`${service} CI build step must not receive Cloudflare credentials`)
  }
  if (/(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+db:migrate:remote\b/.test(migrationBlock)) {
    violations.push(`${service} CI migration step must not invoke a package lifecycle command`)
  }
  if (!/wrangler\s+d1\s+migrations\s+apply[\s\S]*--remote/.test(migrationBlock)) {
    violations.push(`${service} CI migration step must use a fixed Wrangler migration command`)
  }
  if (/(?:pnpm|npm|yarn)\s+[^\n]*\brun\s+deploy\b/.test(deployBlock)) {
    violations.push(`${service} CI deploy step must not invoke a package lifecycle command`)
  }
  if (!/wrangler\s+deploy[\s\S]*--no-bundle/.test(deployBlock)) {
    violations.push(`${service} CI deploy step must use a fixed no-bundle Wrangler command`)
  }
  const workerName = service.replaceAll('_', '-')
  let adminDomainBinding
  try {
    const config = parseJsonc(adminConfigSource)
    adminDomainBinding = Array.isArray(config.services)
      ? config.services.find((entry) => entry?.binding === 'EXAMPLE_SERVICE')?.service
      : undefined
  } catch {
    adminDomainBinding = undefined
  }
  if (adminDomainBinding !== workerName) {
    violations.push(`admin must bind EXAMPLE_SERVICE to the copied domain ${workerName}`)
  }
  const suffix = service.toUpperCase()
  if (!new RegExp(`"${suffix}_DB_ID"`).test(opsConfigSource)) {
    violations.push(`ops wrangler config must declare ${suffix}_DB_ID`)
  }
  if (
    !new RegExp(`"binding"\\s*:\\s*"${suffix}"[\\s\\S]*?"service"\\s*:\\s*"${workerName}"`).test(
      opsConfigSource,
    )
  ) {
    violations.push(`ops must bind health target ${suffix} to ${workerName}`)
  }
  if (!new RegExp(`name:\\s*['"]${service}['"]`).test(opsSource)) {
    violations.push(`opsTargets must declare backup target ${service}`)
  }
  if (!new RegExp(`databaseId:\\s*env\\.${suffix}_DB_ID`).test(opsSource)) {
    violations.push(`opsTargets must read ${suffix}_DB_ID for ${service}`)
  }
  if (!new RegExp(`healthBinding:\\s*env\\.${suffix}`).test(opsSource)) {
    violations.push(`opsTargets must health-check ${service} through ${suffix}`)
  }

  const domainWorkerPath = join(root, 'services', service, 'src/worker/index.ts')
  try {
    const domainWorkerSource = await readFile(domainWorkerPath, 'utf8')
    requireMatch(
      domainWorkerSource,
      new RegExp(`internalAuth[\\s\\S]*?ADMIN_TO_${service.toUpperCase()}_KEY`),
      `${service} internal API must use its caller-specific admin key`,
    )
    requireMatch(
      domainWorkerSource,
      /sendNotification\(c\.env\.NOTIFIER,\s*c\.env\.DOMAIN_TO_NOTIFIER_KEY/,
      `${service} notifications must use DOMAIN_TO_NOTIFIER_KEY`,
    )
    requireMatch(
      domainWorkerSource,
      new RegExp(`domainAccessTokenAudience\\(['"]${service}['"]\\)`),
      `${service} JWT audience must be derived from its own service name`,
    )
  } catch {
    violations.push(`${service} must contain a readable src/worker/index.ts`)
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation)
  process.exitCode = 1
} else {
  console.log('production deploy boundary: ok')
}
