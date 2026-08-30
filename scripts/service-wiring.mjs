import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseJsonc } from './check-production-config.mjs'
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

export function validateServiceWiringSources(catalog, sources) {
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
  requireReviewedOrder(
    'production',
    [
      verifyDigestRegistration,
      installRegistration,
      ...configRegistrations,
      ...remoteSecretRegistrations,
      ...deployRegistrations,
    ],
    violations,
  )

  if (sources.adminConfig && sources.opsConfig && sources.opsSource) {
    try {
      const adminConfig = parseJsonc(sources.adminConfig)
      const opsConfig = parseJsonc(sources.opsConfig)
      const domainDirectories = catalog.services
        .filter((service) => service.deployable && service.directory !== 'admin')
        .map((service) => service.directory)
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
      const adminDomainBindings = (adminConfig.services ?? [])
        .filter((entry) => entry?.binding !== 'NOTIFIER')
        .map((entry) => String(entry.service).replaceAll('-', '_'))
      compareCollection(
        'admin production domain binding',
        domainDirectories,
        adminDomainBindings,
        violations,
      )
    } catch (error) {
      violations.push(`production service surface config is malformed: ${error.message}`)
    }
  }

  const bootstrap = parseWorkflow('production-bootstrap.yml', sources.bootstrap ?? '', violations)
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
    opsConfig,
    opsSource,
  ] = await Promise.all([
    readFile(join(root, 'Makefile'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(join(root, '.github/workflows/ci.yml'), 'utf8'),
    readFile(join(root, '.github/workflows/production-bootstrap.yml'), 'utf8'),
    readFile(join(root, 'scripts/check-deploy-boundary.mjs'), 'utf8'),
    readFile(join(root, 'services/admin/wrangler.jsonc'), 'utf8'),
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
    opsConfig,
    opsSource,
  })
}
