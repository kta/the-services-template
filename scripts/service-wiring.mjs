import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDomainSyncIdentity as resolveAdminDomainSyncIdentity } from '../services/admin/src/worker/domain-sync-identity.mjs'
import { parseJsonc, productionDomainIdentity } from './check-production-config.mjs'
import { parseGithubWorkflow } from './workflow-policy.mjs'

function mapping(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function steps(workflow, jobName) {
  const value = mapping(workflow.jobs)?.[jobName]?.steps
  return Array.isArray(value) ? value.filter((step) => mapping(step)) : []
}

function compareCollection(label, expectedValues, actualValues, violations) {
  const counts = new Map()
  for (const value of actualValues) counts.set(value, (counts.get(value) ?? 0) + 1)
  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort()
  if (duplicates.length) violations.push(`${label} contains duplicate ${duplicates.join(', ')}`)
  const expected = new Set(expectedValues)
  const actual = new Set(actualValues)
  const missing = [...expected].filter((value) => !actual.has(value)).sort()
  const extra = [...actual].filter((value) => !expected.has(value)).sort()
  if (missing.length || extra.length) {
    const parts = []
    if (missing.length) parts.push(`missing ${missing.join(', ')}`)
    if (extra.length) parts.push(`extra ${extra.join(', ')}`)
    violations.push(`${label} must exactly match service-catalog.json: ${parts.join('; ')}`)
  }
}

function parseRuntimeDomainIdentityTuples(value, violations) {
  if (typeof value !== 'string') {
    violations.push('admin runtime domain identities must be a reviewed JSON array')
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    violations.push('admin runtime domain identities must be a reviewed JSON array')
    return []
  }
  if (!Array.isArray(parsed)) {
    violations.push('admin runtime domain identities must be a reviewed JSON array')
    return []
  }
  return parsed.map((entry) => {
    const object = mapping(entry)
    if (!object || Object.keys(object).sort().join('|') !== 'binding|directory|secret') {
      return '<invalid>'
    }
    return `${object.directory}|${object.binding}|${object.secret}`
  })
}

function validateExecutableRuntimeDomainAdapter(domainIdentities, resolver, violations) {
  const environment = Object.create(null)
  const expected = new Map()
  for (const identity of domainIdentities) {
    const binding = Object.freeze({ fetch: () => Promise.resolve(new Response()) })
    const secret = `checked:${identity.secret}`
    environment[identity.binding] = binding
    environment[identity.secret] = secret
    expected.set(identity.directory, { binding, secret })
  }
  for (const identity of domainIdentities) {
    try {
      const resolved = resolver(environment, identity)
      const target = expected.get(identity.directory)
      if (
        resolved?.directory !== identity.directory ||
        resolved?.binding !== target?.binding ||
        resolved?.key !== target?.secret
      ) {
        violations.push(
          `admin executable runtime domain adapter must resolve ${identity.directory} through ${identity.binding} and ${identity.secret}`,
        )
      }
    } catch (error) {
      violations.push(
        `admin executable runtime domain adapter failed for ${identity.directory}: ${error instanceof Error ? error.message : 'failure'}`,
      )
    }
  }
}

function generatedEnvDomainFields(source, pattern) {
  const baseEnv = source.match(/interface\s+__BaseEnv_Env\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  return [...baseEnv.matchAll(pattern)].map((match) => match[1])
}

function parseWorkflow(label, source, violations) {
  try {
    return parseGithubWorkflow(source)
  } catch (error) {
    violations.push(`${label} must be valid safe YAML: ${error.message}`)
    return { jobs: {} }
  }
}

const GITHUB_EXPRESSION = '$' + '{{'
const TRUSTED_NODE = `${GITHUB_EXPRESSION} steps.trusted-tools.outputs.node }}`
const TRUSTED_PNPM = `${GITHUB_EXPRESSION} steps.trusted-tools.outputs.pnpm }}`
const DOMAIN_SERVICE_INPUT = `${GITHUB_EXPRESSION} inputs.domain_service }}`
const DOMAIN_SERVICE = '"$DOMAIN_SERVICE"'

function exactRootStep(jobSteps, name, run, label, violations, options = {}) {
  const matches = jobSteps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.name === name)
  if (matches.length !== 1) {
    violations.push(`${label} must use the exact wrapper exactly once`)
    return { index: -1, step: undefined, valid: false }
  }
  const result = matches[0]
  let valid = true
  if (result.step.run !== run) {
    violations.push(`${label} must use the exact wrapper`)
    valid = false
  }
  const allowedFields = new Set(['name', 'run', 'env'])
  if (options.id !== undefined) allowedFields.add('id')
  const unreviewedFields = Object.keys(result.step).filter((field) => !allowedFields.has(field))
  if (unreviewedFields.length > 0) {
    violations.push(
      `${label} must execute as the exact root step; unreviewed fields ${unreviewedFields.join(', ')}`,
    )
    valid = false
  }
  if (options.id !== undefined && result.step.id !== options.id) {
    violations.push(`${label} must use the exact step id ${options.id}`)
    valid = false
  }
  if (result.step.env !== undefined && !mapping(result.step.env)) {
    violations.push(`${label} env must be a mapping`)
    valid = false
  }
  const allowedEnv = new Set(options.allowedEnv ?? [])
  if (options.domain) allowedEnv.add('DOMAIN_SERVICE')
  if (options.pnpm) allowedEnv.add('PRODUCTION_PNPM_PATH')
  const unreviewedEnv = Object.keys(mapping(result.step.env) ?? {}).filter(
    (name) => !allowedEnv.has(name),
  )
  if (unreviewedEnv.length > 0) {
    violations.push(`${label} contains unreviewed env ${unreviewedEnv.join(', ')}`)
    valid = false
  }
  if (options.domain) {
    if (mapping(result.step.env)?.DOMAIN_SERVICE !== DOMAIN_SERVICE_INPUT) {
      violations.push(`${label} must receive the exact catalog domain input through DOMAIN_SERVICE`)
      valid = false
    }
  }
  if (options.pnpm) {
    if (mapping(result.step.env)?.PRODUCTION_PNPM_PATH !== TRUSTED_PNPM) {
      violations.push(`${label} must receive the trusted production pnpm path`)
      valid = false
    }
  }
  return { ...result, valid }
}

function requireReviewedOrder(label, registrations, violations) {
  const indices = registrations.map(({ index }) => index)
  if (indices.some((index) => index < 0)) return
  if (indices.some((index, position) => position > 0 && index <= indices[position - 1])) {
    violations.push(`${label} wrapper steps must follow the reviewed order`)
  }
}

function exactKeys(value, expected) {
  if (!mapping(value)) return false
  const actualKeys = Object.keys(value).sort()
  const expectedKeys = Object.keys(expected).sort()
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key])
  )
}

function exactFields(step, fields) {
  const actual = Object.keys(step).sort()
  const expected = [...fields].sort()
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  )
}

function runDigest(step) {
  return typeof step.run === 'string'
    ? createHash('sha256').update(step.run).digest('hex')
    : undefined
}

const CHECKOUT_ACTION = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const PNPM_ACTION = 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86'
const NODE_ACTION = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'
const DOWNLOAD_ACTION = 'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131'
const TRUSTED_PATH = `${GITHUB_EXPRESSION} steps.trusted-tools.outputs.path }}`
const REVIEWED_ACCOUNT = `${GITHUB_EXPRESSION} steps.reviewed-resources.outputs.account_id }}`

function exactNamedRunStep(step, expected) {
  if (step.name !== expected.name || step.run !== expected.run) return false
  if (!exactFields(step, expected.fields ?? ['name', 'run'])) return false
  if (expected.id !== undefined && step.id !== expected.id) return false
  if (expected.shell !== undefined && step.shell !== expected.shell) return false
  if (expected.if !== undefined && step.if !== expected.if) return false
  if (expected.cwd !== undefined && step['working-directory'] !== expected.cwd) return false
  if (expected.env !== undefined && !exactKeys(step.env, expected.env)) return false
  return true
}

function reviewedCredentialedStepProfile(workflowPath, step) {
  if (
    step.uses === CHECKOUT_ACTION &&
    exactFields(step, ['uses', 'with']) &&
    exactKeys(step.with, { ref: 'main', 'fetch-depth': 0, 'persist-credentials': false })
  ) {
    return 'checkout-main'
  }
  if (step.uses === PNPM_ACTION && exactFields(step, ['uses'])) return 'pnpm-setup'
  if (
    step.uses === NODE_ACTION &&
    exactFields(step, ['uses', 'with']) &&
    exactKeys(step.with, { 'node-version': 22, cache: 'pnpm' })
  ) {
    return 'node-setup'
  }
  const artifactWith =
    workflowPath === 'ci.yml'
      ? { name: 'production-worker-bundles' }
      : { name: 'production-bootstrap-worker-bundles', path: '.' }
  if (
    step.uses === DOWNLOAD_ACTION &&
    exactFields(step, ['uses', 'with']) &&
    exactKeys(step.with, artifactWith)
  ) {
    return 'download-reviewed-artifact'
  }
  if (
    exactFields(step, ['run']) &&
    step.run === 'pnpm install --frozen-lockfile --ignore-scripts'
  ) {
    return 'install-frozen-dependencies'
  }
  if (
    exactNamedRunStep(step, {
      name: 'Pin checkout to the actual main branch',
      run: 'git checkout -B main "$GITHUB_SHA"',
    })
  ) {
    return 'pin-main-checkout'
  }
  if (
    step.name === 'Capture trusted production tool paths' &&
    step.id === 'trusted-tools' &&
    step.shell === 'bash' &&
    exactFields(step, ['name', 'id', 'shell', 'run']) &&
    runDigest(step) === '248ce4fb64c44f23f16e295d349f3c6473481b15e055320b29aa08543449ca21'
  ) {
    return 'capture-trusted-tools'
  }
  if (
    exactNamedRunStep(step, {
      name: 'Verify locked Wrangler before production credentials',
      run: 'test "$($PNPM --config.offline=true exec wrangler --version)" = "4.125.0"',
      fields: ['name', 'env', 'working-directory', 'run'],
      cwd: 'services/admin',
      env: { PNPM: TRUSTED_PNPM },
    })
  ) {
    return 'verify-locked-wrangler'
  }
  const checkoutGuard =
    workflowPath === 'ci.yml'
      ? {
          name: 'Revalidate published protected main before production credentials',
          run: `${TRUSTED_NODE} scripts/require-production-deploy.mjs`,
        }
      : {
          name: 'Require protected main bootstrap boundary',
          run: `${TRUSTED_NODE} scripts/require-production-bootstrap.mjs`,
        }
  if (
    exactNamedRunStep(step, {
      ...checkoutGuard,
      fields: ['name', 'env', 'run'],
      env: { PATH: TRUSTED_PATH },
    })
  ) {
    return 'protected-main-guard'
  }
  if (
    exactNamedRunStep(step, {
      name: 'Verify GitHub production environment policy',
      run: `${TRUSTED_NODE} scripts/check-github-production-environment.mjs`,
      fields: ['name', 'env', 'run'],
      env: {
        GITHUB_TOKEN: `${GITHUB_EXPRESSION} github.token }}`,
        GITHUB_REPOSITORY: `${GITHUB_EXPRESSION} github.repository }}`,
        PATH: TRUSTED_PATH,
      },
    })
  ) {
    return 'verify-production-environment'
  }
  if (
    workflowPath === 'production-bootstrap.yml' &&
    exactNamedRunStep(step, {
      name: 'Verify exact-SHA CI result before production credentials',
      run: `${TRUSTED_NODE} scripts/require-github-verify.mjs`,
      fields: ['name', 'env', 'run'],
      env: {
        GITHUB_TOKEN: `${GITHUB_EXPRESSION} github.token }}`,
        GITHUB_REPOSITORY: `${GITHUB_EXPRESSION} github.repository }}`,
        GITHUB_SHA: `${GITHUB_EXPRESSION} github.sha }}`,
        PATH: TRUSTED_PATH,
      },
    })
  ) {
    return 'verify-ci-result'
  }
  if (
    exactNamedRunStep(step, {
      name: 'Resolve reviewed production resource identities before credentials',
      run: `${TRUSTED_NODE} scripts/production-resource-identities.mjs`,
      fields: ['name', 'id', 'run'],
      id: 'reviewed-resources',
    })
  ) {
    return 'resolve-reviewed-resources'
  }
  if (
    step.name === 'Verify Cloudflare account and D1 resource identities' &&
    step.shell === 'bash' &&
    exactFields(step, ['name', 'env', 'shell', 'run']) &&
    runDigest(step) === '96d20b58ed6e0bda60cb79afce311ccfdafe4da43769bb367c01c8cbd67802db'
  ) {
    const expected = {
      CLOUDFLARE_API_TOKEN: `${GITHUB_EXPRESSION} secrets.CLOUDFLARE_API_TOKEN }}`,
      CLOUDFLARE_ACCOUNT_ID: `${GITHUB_EXPRESSION} secrets.CLOUDFLARE_ACCOUNT_ID }}`,
      REVIEWED_ACCOUNT_ID: REVIEWED_ACCOUNT,
      REVIEWED_DEDUPE_ID: `${GITHUB_EXPRESSION} steps.reviewed-resources.outputs.dedupe_id }}`,
      REVIEWED_BUCKET_NAME: `${GITHUB_EXPRESSION} steps.reviewed-resources.outputs.bucket_name }}`,
      EXPECTED_DEDUPE_ID: `${GITHUB_EXPRESSION} secrets.PRODUCTION_NOTIFIER_DEDUPE_ID }}`,
      EXPECTED_BUCKET_NAME: `${GITHUB_EXPRESSION} secrets.PRODUCTION_BACKUP_BUCKET_NAME }}`,
      PRODUCTION_RESOURCE_MANIFEST: `${GITHUB_EXPRESSION} secrets.PRODUCTION_RESOURCE_MANIFEST }}`,
      REVIEWED_D1_IDENTITIES: `${GITHUB_EXPRESSION} steps.reviewed-resources.outputs.database_identities }}`,
      ...(workflowPath === 'production-bootstrap.yml'
        ? {
            REVIEWED_BACKUP_SIGNING_PUBLIC_KEY_B64: `${GITHUB_EXPRESSION} steps.reviewed-resources.outputs.backup_signing_public_key_b64 }}`,
          }
        : {}),
    }
    if (exactKeys(step.env, expected)) return 'verify-cloudflare-resources'
  }
  const r2Name =
    workflowPath === 'ci.yml'
      ? 'Verify R2 backup bucket privacy'
      : 'Verify R2 backup bucket privacy before provisioning'
  if (
    step.name === r2Name &&
    (workflowPath === 'ci.yml'
      ? step.shell === undefined && exactFields(step, ['name', 'env', 'run'])
      : step.shell === 'bash' && exactFields(step, ['name', 'env', 'shell', 'run'])) &&
    runDigest(step) === 'cf495d414f12e25b087ecbcbdba792ad93ffaa015f31cb3c8b7e559639bfd5a3' &&
    exactKeys(step.env, {
      CLOUDFLARE_API_TOKEN: `${GITHUB_EXPRESSION} secrets.CLOUDFLARE_API_TOKEN }}`,
      CLOUDFLARE_ACCOUNT_ID: `${GITHUB_EXPRESSION} secrets.CLOUDFLARE_ACCOUNT_ID }}`,
    })
  ) {
    return 'verify-r2-private'
  }
  if (
    workflowPath === 'production-bootstrap.yml' &&
    step.name === 'Bootstrap production Workers with fixed secret bundles' &&
    step.shell === 'bash' &&
    exactFields(step, ['name', 'env', 'shell', 'run']) &&
    runDigest(step) === '9955f2db1410801720c40eb8b08496454742bdb5d8b76a82dfcb267a286e8d98' &&
    exactKeys(step.env, {
      CLOUDFLARE_API_TOKEN: `${GITHUB_EXPRESSION} secrets.CLOUDFLARE_API_TOKEN }}`,
      CLOUDFLARE_ACCOUNT_ID: `${GITHUB_EXPRESSION} secrets.CLOUDFLARE_ACCOUNT_ID }}`,
      DOMAIN_SERVICE: DOMAIN_SERVICE_INPUT,
      PRODUCTION_JWT_PRIVATE_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_JWT_PRIVATE_KEY }}`,
      PRODUCTION_JWT_PUBLIC_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_JWT_PUBLIC_KEY }}`,
      PRODUCTION_DOMAIN_TO_ADMIN_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_DOMAIN_TO_ADMIN_KEY }}`,
      PRODUCTION_ADMIN_TO_DOMAIN_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_ADMIN_TO_DOMAIN_KEY }}`,
      PRODUCTION_ADMIN_TO_NOTIFIER_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_ADMIN_TO_NOTIFIER_KEY }}`,
      PRODUCTION_DOMAIN_TO_NOTIFIER_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_DOMAIN_TO_NOTIFIER_KEY }}`,
      PRODUCTION_OPS_TO_NOTIFIER_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_OPS_TO_NOTIFIER_KEY }}`,
      PRODUCTION_AUTH_PEPPER: `${GITHUB_EXPRESSION} secrets.PRODUCTION_AUTH_PEPPER }}`,
      PRODUCTION_RESEND_API_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_RESEND_API_KEY }}`,
      PRODUCTION_D1_EXPORT_API_TOKEN: `${GITHUB_EXPRESSION} secrets.PRODUCTION_D1_EXPORT_API_TOKEN }}`,
      PRODUCTION_R2_POLICY_CHECK_API_TOKEN: `${GITHUB_EXPRESSION} secrets.PRODUCTION_R2_POLICY_CHECK_API_TOKEN }}`,
      PRODUCTION_BACKUP_SIGNING_PRIVATE_KEY: `${GITHUB_EXPRESSION} secrets.PRODUCTION_BACKUP_SIGNING_PRIVATE_KEY }}`,
    })
  ) {
    return 'prepare-bootstrap-secret-bundles'
  }
  if (
    workflowPath === 'production-bootstrap.yml' &&
    exactNamedRunStep(step, {
      name: 'Remove bootstrap secret material',
      run: 'rm -rf -- "$RUNNER_TEMP/production-secret-bundles"',
      fields: ['name', 'if', 'shell', 'run'],
      if: `${GITHUB_EXPRESSION} always() }}`,
      shell: 'bash',
    })
  ) {
    return 'remove-bootstrap-secret-material'
  }
  return undefined
}

function remoteWriteKind(step) {
  const run = typeof step.run === 'string' ? step.run : ''
  if (run.includes('scripts/production-service.mjs')) return 'production service wrapper'
  if (/\bwrangler\s+(?:deploy\b|d1\s+(?:migrations\s+apply|execute)\b|secret\s+put\b)/i.test(run)) {
    return 'raw Wrangler remote write'
  }
  if (
    /api\.cloudflare\.com/i.test(run) &&
    /\bcurl\b/i.test(run) &&
    /(?:--request(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b|-[A-Za-z]*X\s*(?:POST|PUT|PATCH|DELETE)\b|(?:--data(?:-raw|-binary|-urlencode)?|-d)(?:=|\s))/i.test(
      run,
    )
  ) {
    return 'raw Cloudflare API write'
  }
  if (typeof step.uses === 'string' && /^cloudflare\/wrangler-action@/i.test(step.uses)) {
    return 'Wrangler action remote write'
  }
  return undefined
}

function requireExactExecutionContext(workflow, workflowPath, jobName, violations) {
  if (workflow.env !== undefined) {
    violations.push(`${workflowPath} workflow env is outside the exact execution context schema`)
  }
  if (workflow.defaults !== undefined) {
    violations.push(`${workflowPath} defaults and custom default shell are forbidden`)
  }
  const job = mapping(workflow.jobs)?.[jobName]
  const expectedJobEnv =
    workflowPath === 'production-bootstrap.yml'
      ? { PRODUCTION_ENVIRONMENT: 'production' }
      : undefined
  const jobEnvIsExact =
    expectedJobEnv === undefined ? job?.env === undefined : exactKeys(job?.env, expectedJobEnv)
  if (!jobEnvIsExact) {
    violations.push(
      `${workflowPath}:${jobName} job env is outside the exact execution context schema`,
    )
  }
  if (job?.defaults !== undefined) {
    violations.push(`${workflowPath}:${jobName} defaults and custom default shell are forbidden`)
  }
}

function requireCredentialedStepAllowlist(workflowPath, jobSteps, registrations, violations) {
  const registered = new Set(
    registrations.filter(({ index }) => index >= 0).map(({ index }) => index),
  )
  const profiles = new Set()
  for (const [index, step] of jobSteps.entries()) {
    if (registered.has(index)) continue
    const write = remoteWriteKind(step)
    if (write) {
      violations.push(
        `${workflowPath} credentialed job contains unreviewed remote write at steps[${index}]: ${write}`,
      )
      continue
    }
    const profile = reviewedCredentialedStepProfile(workflowPath, step)
    if (!profile) {
      violations.push(
        `${workflowPath} credentialed job contains an unreviewed credentialed step outside the exact step allowlist at steps[${index}]`,
      )
      continue
    }
    if (profiles.has(profile)) {
      violations.push(
        `${workflowPath} credentialed job duplicates exact step allowlist profile ${profile}`,
      )
    }
    profiles.add(profile)
  }
}

export function validateServiceWiringSources(catalog, sources, adapters = {}) {
  const violations = []
  const spaDirectories = catalog.services.map((service) => service.directory)
  const spaPackages = catalog.services.map((service) => service.package)
  const workerPackages = catalog.workerOnlyServices.map((service) => service.package)
  const productionEntries = [...catalog.services, ...catalog.workerOnlyServices].filter(
    (service) => service.deployable,
  )
  const productionDirectories = productionEntries.map((service) => service.directory)
  const migrationDirectories = catalog.services
    .filter((service) => service.deployable)
    .map((service) => service.directory)

  const devServices =
    sources.makefile
      .match(/^DEV_ALL_SERVICES\s*:=\s*(.*)$/m)?.[1]
      ?.trim()
      .split(/\s+/)
      .filter(Boolean) ?? []
  compareCollection('DEV_ALL_SERVICES', spaDirectories, devServices, violations)

  let packageJson
  try {
    packageJson = JSON.parse(sources.packageJson)
  } catch (error) {
    violations.push(`root package.json has malformed JSON: ${error.message}`)
    packageJson = {}
  }
  const testScript = packageJson.scripts?.test ?? ''
  const testRegistrations = [
    ...testScript.matchAll(
      /pnpm --filter (@app\/[a-z][a-z0-9_]*) (test(?=\s*(?:&&|$))|test:all\b)/g,
    ),
  ].map((match) => ({ package: match[1], mode: match[2] }))
  compareCollection(
    'root combined SPA test',
    spaPackages,
    testRegistrations.filter(({ mode }) => mode === 'test:all').map(({ package: name }) => name),
    violations,
  )
  compareCollection(
    'root combined worker test',
    workerPackages,
    testRegistrations
      .filter(
        ({ package: name, mode }) =>
          mode === 'test' && !['@app/contracts', '@app/shared', '@app/ui'].includes(name),
      )
      .map(({ package: name }) => name),
    violations,
  )
  for (const registration of testRegistrations) {
    const expectedMode = spaPackages.includes(registration.package)
      ? 'test:all'
      : workerPackages.includes(registration.package)
        ? 'test'
        : undefined
    if (expectedMode && registration.mode !== expectedMode) {
      violations.push(
        `root combined test has wrong mode for ${registration.package}: ${registration.mode}; expected ${expectedMode}`,
      )
    }
  }

  const ci = parseWorkflow('ci.yml', sources.ci, violations)
  requireExactExecutionContext(ci, 'ci.yml', 'deploy', violations)
  const include = mapping(mapping(mapping(ci.jobs)?.e2e)?.strategy)?.matrix?.include
  const e2eEntries = Array.isArray(include) ? include : []
  const e2eDirectories = []
  for (const [index, entry] of e2eEntries.entries()) {
    if (
      !mapping(entry) ||
      typeof entry.name !== 'string' ||
      entry.pkg !== `@app/${entry.name}` ||
      entry.dir !== `services/${entry.name}`
    ) {
      violations.push(
        `manual E2E matrix identity mismatch at entry ${index}: ${String(entry?.name ?? 'unknown')}`,
      )
      continue
    }
    e2eDirectories.push(entry.name)
  }
  compareCollection('manual E2E matrix', spaDirectories, e2eDirectories, violations)

  const buildSteps = steps(ci, 'build-production')
  const deploySteps = steps(ci, 'deploy')
  const buildRegistrations = productionDirectories.map((directory) =>
    exactRootStep(
      buildSteps,
      `Build ${directory} (no Cloudflare credentials)`,
      `node scripts/production-service.mjs ${directory} build`,
      `production build step ${directory}`,
      violations,
    ),
  )
  const expectedProductionArgv = productionDirectories.join(' ')
  const packageRegistration = exactRootStep(
    buildSteps,
    'Verify and package production Worker bundles',
    `node scripts/production-artifacts.mjs ci package ${expectedProductionArgv}`,
    `production package must exactly use catalog services: expected ${expectedProductionArgv.replaceAll(' ', ', ')}`,
    violations,
  )
  const digestRegistration = exactRootStep(
    buildSteps,
    'Record exact Worker bundle digest',
    'node scripts/production-artifacts.mjs ci record-digest',
    'production digest step',
    violations,
    { id: 'package-worker-artifact' },
  )
  requireReviewedOrder(
    'production build',
    [...buildRegistrations, packageRegistration, digestRegistration],
    violations,
  )

  const verifyDigestRegistration = exactRootStep(
    deploySteps,
    'Verify exact build artifact digest before credentials',
    'node scripts/production-artifacts.mjs ci verify-digest',
    'production archive digest verifier',
    violations,
    { allowedEnv: ['EXPECTED_BUNDLE_SHA256'] },
  )
  const installRegistration = exactRootStep(
    deploySteps,
    'Verify and install reviewed production Worker bundles',
    `${TRUSTED_NODE} scripts/production-artifacts.mjs ci install ${expectedProductionArgv}`,
    `production install must exactly use catalog services: expected ${expectedProductionArgv.replaceAll(' ', ', ')}`,
    violations,
  )
  const configRegistrations = productionDirectories.map((directory) =>
    exactRootStep(
      deploySteps,
      `Verify ${directory} production config before credentials`,
      `${TRUSTED_NODE} scripts/production-service.mjs ${directory} config`,
      `production config step ${directory}`,
      violations,
      { allowedEnv: ['CLOUDFLARE_ACCOUNT_ID', 'PATH'] },
    ),
  )
  const remoteSecretRegistrations = productionDirectories.map((directory) =>
    exactRootStep(
      deploySteps,
      `Verify ${directory} remote production secret names`,
      `${TRUSTED_NODE} scripts/production-service.mjs ${directory} remote-secrets`,
      `production remote-secret step ${directory}`,
      violations,
      { allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
    ),
  )
  const deployRegistrations = []
  const notifier = productionEntries.find((service) => service.directory === 'notifier')
  if (notifier) {
    deployRegistrations.push(
      exactRootStep(
        deploySteps,
        'Deploy notifier',
        `${TRUSTED_NODE} scripts/production-service.mjs notifier deploy`,
        'production deploy step notifier',
        violations,
        { pnpm: true, allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
      ),
    )
  }
  for (const directory of migrationDirectories) {
    deployRegistrations.push(
      exactRootStep(
        deploySteps,
        `Apply ${directory} remote migrations`,
        `${TRUSTED_NODE} scripts/production-service.mjs ${directory} migrate`,
        `production migration step ${directory}`,
        violations,
        { pnpm: true, allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
      ),
      exactRootStep(
        deploySteps,
        `Deploy ${directory}`,
        `${TRUSTED_NODE} scripts/production-service.mjs ${directory} deploy`,
        `production deploy step ${directory}`,
        violations,
        { pnpm: true, allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
      ),
    )
  }
  for (const service of productionEntries.filter(
    (candidate) =>
      !migrationDirectories.includes(candidate.directory) && candidate.directory !== 'notifier',
  )) {
    deployRegistrations.push(
      exactRootStep(
        deploySteps,
        `Deploy ${service.directory}`,
        `${TRUSTED_NODE} scripts/production-service.mjs ${service.directory} deploy`,
        `production deploy step ${service.directory}`,
        violations,
        { pnpm: true, allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
      ),
    )
  }
  const productionSequence = [
    verifyDigestRegistration,
    installRegistration,
    ...configRegistrations,
    ...remoteSecretRegistrations,
    ...deployRegistrations,
  ]
  requireReviewedOrder('production', productionSequence, violations)
  requireCredentialedStepAllowlist('ci.yml', deploySteps, productionSequence, violations)

  if (sources.adminConfig && sources.opsConfig && sources.opsSource) {
    try {
      const adminConfig = parseJsonc(sources.adminConfig)
      const opsConfig = parseJsonc(sources.opsConfig)
      const domainIdentities = catalog.services
        .filter((service) => service.deployable && service.directory !== 'admin')
        .map((service) => productionDomainIdentity(service.directory))
      const domainDirectories = domainIdentities.map(({ directory }) => directory)
      const databaseServices = Object.keys(opsConfig.vars ?? {})
        .map((name) => name.match(/^([A-Z][A-Z0-9_]*)_DB_ID$/)?.[1]?.toLowerCase())
        .filter(Boolean)
      compareCollection(
        'production D1 resource identities',
        migrationDirectories,
        databaseServices,
        violations,
      )
      const opsDomainBindings = (opsConfig.services ?? [])
        .filter((entry) => !['ADMIN', 'NOTIFIER'].includes(entry?.binding))
        .map((entry) => String(entry.service).replaceAll('-', '_'))
      compareCollection(
        'ops production health bindings',
        domainDirectories,
        opsDomainBindings,
        violations,
      )
      const opsTargets = sources.opsSource
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      const targetDomains = [...opsTargets.matchAll(/\bname:\s*['"]([a-z][a-z0-9_]*)['"]/g)]
        .map((match) => match[1])
        .filter((name) => !['admin', 'notifier', 'ops'].includes(name))
      compareCollection(
        'ops production backup/health targets',
        domainDirectories,
        targetDomains,
        violations,
      )
      const adminDomainBindingTuples = (adminConfig.services ?? [])
        .filter((entry) => entry?.binding !== 'NOTIFIER')
        .map((entry) => `${String(entry.service)}|${String(entry.binding)}`)
      compareCollection(
        'admin production domain binding tuples',
        domainIdentities.map(({ service, binding }) => `${service}|${binding}`),
        adminDomainBindingTuples,
        violations,
      )
      const adminDomainSecrets = (adminConfig.secrets?.required ?? []).filter(
        (name) => /^ADMIN_TO_[A-Z][A-Z0-9_]*_KEY$/.test(name) && name !== 'ADMIN_TO_NOTIFIER_KEY',
      )
      compareCollection(
        'admin production domain secrets',
        domainIdentities.map(({ secret }) => secret),
        adminDomainSecrets,
        violations,
      )
      compareCollection(
        'admin runtime domain identities',
        domainIdentities.map(
          ({ directory, binding, secret }) => `${directory}|${binding}|${secret}`,
        ),
        parseRuntimeDomainIdentityTuples(adminConfig.vars?.ADMIN_DOMAIN_IDENTITIES, violations),
        violations,
      )
      validateExecutableRuntimeDomainAdapter(
        domainIdentities,
        adapters.resolveDomainSyncIdentity ?? resolveAdminDomainSyncIdentity,
        violations,
      )

      if (sources.adminGeneratedEnv !== undefined) {
        const generatedBindings = generatedEnvDomainFields(
          sources.adminGeneratedEnv,
          /^\s*([A-Z][A-Z0-9_]*):\s*Fetcher\b/gm,
        ).filter((name) => name !== 'NOTIFIER')
        const generatedSecrets = generatedEnvDomainFields(
          sources.adminGeneratedEnv,
          /^\s*(ADMIN_TO_[A-Z][A-Z0-9_]*_KEY):\s*string\b/gm,
        ).filter((name) => name !== 'ADMIN_TO_NOTIFIER_KEY')
        compareCollection(
          'admin generated Env domain bindings',
          domainIdentities.map(({ binding }) => binding),
          generatedBindings,
          violations,
        )
        compareCollection(
          'admin generated Env domain secrets',
          domainIdentities.map(({ secret }) => secret),
          generatedSecrets,
          violations,
        )
        if (
          !/^\s*ADMIN_DOMAIN_IDENTITIES:\s*(?:string\b|"(?:[^"\\]|\\.)*")/m.test(
            sources.adminGeneratedEnv,
          )
        ) {
          violations.push('admin generated Env must expose ADMIN_DOMAIN_IDENTITIES')
        }
      }
    } catch (error) {
      violations.push(`production service surface config is malformed: ${error.message}`)
    }
  }

  const bootstrap = parseWorkflow('production-bootstrap.yml', sources.bootstrap ?? '', violations)
  requireExactExecutionContext(bootstrap, 'production-bootstrap.yml', 'bootstrap', violations)
  const bootstrapBuildSteps = steps(bootstrap, 'build-production')
  const bootstrapCredentialedSteps = steps(bootstrap, 'bootstrap')
  const buildGuard = exactRootStep(
    bootstrapBuildSteps,
    'Validate copied domain input before package selection',
    `node scripts/production-service.mjs ${DOMAIN_SERVICE} guard-domain`,
    'production-bootstrap.yml build-production catalog domain guard',
    violations,
    { domain: true },
  )
  const credentialedGuard = exactRootStep(
    bootstrapCredentialedSteps,
    'Require a catalog deployable domain before credentials',
    `node scripts/production-service.mjs ${DOMAIN_SERVICE} guard-domain`,
    'production-bootstrap.yml bootstrap catalog domain guard',
    violations,
    { domain: true },
  )
  const firstCredentialedStep = bootstrapCredentialedSteps.findIndex((step) =>
    /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/.test(JSON.stringify(step)),
  )
  if (
    !buildGuard.valid ||
    !credentialedGuard.valid ||
    (firstCredentialedStep >= 0 && credentialedGuard.index >= firstCredentialedStep)
  ) {
    violations.push(
      'production-bootstrap.yml both jobs must use the exact catalog domain guard before credentials',
    )
  }
  const bootstrapBuildRegistrations = [
    buildGuard,
    exactRootStep(
      bootstrapBuildSteps,
      'Build admin without Cloudflare credentials',
      'node scripts/production-service.mjs admin build',
      'production-bootstrap.yml admin build step',
      violations,
    ),
    exactRootStep(
      bootstrapBuildSteps,
      'Build notifier without Cloudflare credentials',
      'node scripts/production-service.mjs notifier build',
      'production-bootstrap.yml notifier build step',
      violations,
    ),
    exactRootStep(
      bootstrapBuildSteps,
      'Build ops without Cloudflare credentials',
      'node scripts/production-service.mjs ops build',
      'production-bootstrap.yml ops build step',
      violations,
    ),
    exactRootStep(
      bootstrapBuildSteps,
      'Build copied domain without Cloudflare credentials',
      `node scripts/production-service.mjs ${DOMAIN_SERVICE} build`,
      'production-bootstrap.yml copied domain build step',
      violations,
      { domain: true },
    ),
    exactRootStep(
      bootstrapBuildSteps,
      'Verify and package production Worker bundles',
      `node scripts/production-artifacts.mjs bootstrap package admin notifier ops ${DOMAIN_SERVICE}`,
      'production-bootstrap.yml package step',
      violations,
      { domain: true },
    ),
    exactRootStep(
      bootstrapBuildSteps,
      'Record exact Worker bundle digest',
      'node scripts/production-artifacts.mjs bootstrap record-digest',
      'production-bootstrap.yml digest step',
      violations,
      { id: 'package-worker-artifact' },
    ),
  ]
  requireReviewedOrder(
    'production-bootstrap.yml build-production',
    bootstrapBuildRegistrations,
    violations,
  )

  const bootstrapConfigServices = ['admin', 'notifier', 'ops']
  const bootstrapSequence = [
    credentialedGuard,
    exactRootStep(
      bootstrapCredentialedSteps,
      'Verify exact build artifact digest before credentials',
      'node scripts/production-artifacts.mjs bootstrap verify-digest',
      'production-bootstrap.yml archive digest verifier',
      violations,
      { allowedEnv: ['EXPECTED_BUNDLE_SHA256'] },
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Verify and install reviewed production Worker bundles',
      `${TRUSTED_NODE} scripts/production-artifacts.mjs bootstrap install admin notifier ops ${DOMAIN_SERVICE}`,
      'production-bootstrap.yml install step',
      violations,
      { domain: true },
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Require protected main bootstrap boundary',
      `${TRUSTED_NODE} scripts/require-production-bootstrap.mjs`,
      'production-bootstrap.yml protected-main guard',
      violations,
      { allowedEnv: ['PATH'] },
    ),
    ...bootstrapConfigServices.map((directory) =>
      exactRootStep(
        bootstrapCredentialedSteps,
        `Verify ${directory} production config before credentials`,
        `${TRUSTED_NODE} scripts/production-service.mjs ${directory} config`,
        `production-bootstrap.yml ${directory} config step`,
        violations,
        { allowedEnv: ['CLOUDFLARE_ACCOUNT_ID', 'PATH'] },
      ),
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Verify copied domain production config before credentials',
      `${TRUSTED_NODE} scripts/production-service.mjs ${DOMAIN_SERVICE} config`,
      'production-bootstrap.yml copied domain config step',
      violations,
      { domain: true, allowedEnv: ['CLOUDFLARE_ACCOUNT_ID', 'PATH'] },
    ),
    ...['admin', 'notifier'].map((directory) =>
      exactRootStep(
        bootstrapCredentialedSteps,
        `Verify ${directory} remote production secret names`,
        `${TRUSTED_NODE} scripts/production-service.mjs ${directory} remote-secrets-bootstrap`,
        `production-bootstrap.yml ${directory} remote-secret step`,
        violations,
        { allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
      ),
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Verify copied domain remote production secret names',
      `${TRUSTED_NODE} scripts/production-service.mjs ${DOMAIN_SERVICE} remote-secrets-bootstrap`,
      'production-bootstrap.yml copied domain remote-secret step',
      violations,
      {
        domain: true,
        allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
      },
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Verify ops remote production secret names',
      `${TRUSTED_NODE} scripts/production-service.mjs ops remote-secrets-bootstrap`,
      'production-bootstrap.yml ops remote-secret step',
      violations,
      { allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Bootstrap notifier',
      `${TRUSTED_NODE} scripts/production-service.mjs notifier bootstrap`,
      'production-bootstrap.yml notifier bootstrap step',
      violations,
      { pnpm: true, allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Bootstrap admin',
      `${TRUSTED_NODE} scripts/production-service.mjs admin bootstrap`,
      'production-bootstrap.yml admin bootstrap step',
      violations,
      { pnpm: true, allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Apply copied domain remote migrations',
      `${TRUSTED_NODE} scripts/production-service.mjs ${DOMAIN_SERVICE} migrate`,
      'production-bootstrap.yml copied domain migration step',
      violations,
      {
        domain: true,
        pnpm: true,
        allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
      },
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Bootstrap copied domain',
      `${TRUSTED_NODE} scripts/production-service.mjs ${DOMAIN_SERVICE} bootstrap`,
      'production-bootstrap.yml copied domain bootstrap step',
      violations,
      {
        domain: true,
        pnpm: true,
        allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
      },
    ),
    exactRootStep(
      bootstrapCredentialedSteps,
      'Bootstrap ops',
      `${TRUSTED_NODE} scripts/production-service.mjs ops bootstrap`,
      'production-bootstrap.yml ops bootstrap step',
      violations,
      { pnpm: true, allowedEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
    ),
  ]
  requireReviewedOrder('production-bootstrap.yml bootstrap', bootstrapSequence, violations)
  requireCredentialedStepAllowlist(
    'production-bootstrap.yml',
    bootstrapCredentialedSteps,
    bootstrapSequence,
    violations,
  )
  if (!/loadServiceRepositoryCatalog/.test(sources.productionChecker)) {
    violations.push('production checker must consume the validated service catalog')
  }
  return violations
}

export async function validateServiceWiring(root, catalog) {
  const [
    makefile,
    packageJson,
    ci,
    bootstrap,
    productionChecker,
    adminConfig,
    adminGeneratedEnv,
    opsConfig,
    opsSource,
  ] = await Promise.all([
    readFile(join(root, 'Makefile'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(join(root, '.github/workflows/ci.yml'), 'utf8'),
    readFile(join(root, '.github/workflows/production-bootstrap.yml'), 'utf8'),
    readFile(join(root, 'scripts/check-deploy-boundary.mjs'), 'utf8'),
    readFile(join(root, 'services/admin/wrangler.jsonc'), 'utf8'),
    readFile(join(root, 'services/admin/worker-configuration.d.ts'), 'utf8'),
    readFile(join(root, 'services/ops/wrangler.jsonc'), 'utf8'),
    readFile(join(root, 'services/ops/src/index.ts'), 'utf8'),
  ])
  return validateServiceWiringSources(catalog, {
    makefile,
    packageJson,
    ci,
    bootstrap,
    productionChecker,
    adminConfig,
    adminGeneratedEnv,
    opsConfig,
    opsSource,
  })
}
