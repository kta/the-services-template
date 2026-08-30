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

function shellSource(jobSteps) {
  return jobSteps
    .flatMap((step) => (typeof step.run === 'string' ? step.run.split('\n') : []))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^echo\b/.test(line))
    .join('\n')
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

function multilineCommandArguments(source, commandName, argumentPattern) {
  const values = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(commandName)) continue
    let command = lines[index]
    while (command.trimEnd().endsWith('\\') && index + 1 < lines.length) {
      index += 1
      command += `\n${lines[index]}`
    }
    for (const match of command.matchAll(argumentPattern)) values.push(match[1])
  }
  return values
}

function bootstrapHasGuard(workflow, jobName) {
  const jobSteps = steps(workflow, jobName)
  const guardIndex = jobSteps.findIndex(
    (step) =>
      typeof step.run === 'string' &&
      /service-catalog\.mjs\s+require-deployable\s+["']?\$DOMAIN_SERVICE["']?/.test(step.run),
  )
  if (guardIndex < 0) return false
  const credentialIndex = jobSteps.findIndex((step) =>
    /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/.test(JSON.stringify(step)),
  )
  return credentialIndex < 0 || guardIndex < credentialIndex
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
  const productionPackages = productionEntries.map((service) => service.package)
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

  const buildSource = shellSource(steps(ci, 'build-production'))
  const deploySteps = steps(ci, 'deploy')
  const deploySource = shellSource(deploySteps)
  const buildPackages = [
    ...buildSource.matchAll(/pnpm\s+--filter\s+(@app\/[a-z][a-z0-9_]*)\s+run\s+build\b/g),
  ].map((match) => match[1])
  compareCollection('production build', productionPackages, buildPackages, violations)
  const artifactServices = multilineCommandArguments(
    buildSource,
    'verify-worker-artifact.mjs',
    /--service\s+([a-z][a-z0-9_]*)/g,
  )
  compareCollection(
    'production artifact verifier',
    productionDirectories,
    artifactServices,
    violations,
  )
  const tarServices = [...buildSource.matchAll(/\bservices\/([a-z][a-z0-9_]*)\/dist\b/g)].map(
    (match) => match[1],
  )
  compareCollection('production tar paths', productionDirectories, tarServices, violations)
  const installServices = multilineCommandArguments(
    deploySource,
    'verify-worker-artifact.mjs',
    /--service\s+([a-z][a-z0-9_]*)/g,
  )
  compareCollection(
    'production install verifier',
    productionDirectories,
    installServices,
    violations,
  )
  const configServices = multilineCommandArguments(
    deploySource,
    'check-production-config.mjs',
    /check-production-config\.mjs\s+([a-z][a-z0-9_]*)/g,
  )
  compareCollection('production config verifier', productionDirectories, configServices, violations)
  const migrationServices = deploySteps
    .filter(
      (step) =>
        /^Apply [a-z][a-z0-9_]* remote migrations$/.test(step.name ?? '') &&
        /wrangler\s+d1\s+migrations\s+apply\b[\s\S]*--remote/.test(step.run ?? ''),
    )
    .map((step) => step.name.match(/^Apply ([a-z][a-z0-9_]*) remote migrations$/)[1])
  compareCollection('production migration', migrationDirectories, migrationServices, violations)
  const deployServices = deploySteps
    .filter(
      (step) =>
        /^Deploy [a-z][a-z0-9_]*$/.test(step.name ?? '') &&
        /wrangler\s+deploy\b[\s\S]*--no-bundle/.test(step.run ?? ''),
    )
    .map((step) => step.name.match(/^Deploy ([a-z][a-z0-9_]*)$/)[1])
  compareCollection('production deploy', productionDirectories, deployServices, violations)
  for (const step of deploySteps.filter((step) =>
    /^Deploy [a-z][a-z0-9_]*$/.test(step.name ?? ''),
  )) {
    const directory = step.name.slice('Deploy '.length)
    if (step['working-directory'] !== `services/${directory}`) {
      violations.push(`production deploy identity mismatch for ${directory}: working-directory`)
    }
  }
  const remoteSecretServices = multilineCommandArguments(
    deploySource,
    'check_remote_secret_names ',
    /check_remote_secret_names\s+([a-z][a-z0-9_]*)/g,
  )
  compareCollection(
    'production remote-secret verifier',
    productionDirectories,
    remoteSecretServices,
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
      const expectedAdminDomains = domainDirectories.length
        ? domainDirectories
        : ['example_service']
      compareCollection(
        'admin production domain binding',
        expectedAdminDomains,
        adminDomainBindings,
        violations,
      )
    } catch (error) {
      violations.push(`production service surface config is malformed: ${error.message}`)
    }
  }

  const bootstrap = parseWorkflow('production-bootstrap.yml', sources.bootstrap ?? '', violations)
  if (
    !bootstrapHasGuard(bootstrap, 'build-production') ||
    !bootstrapHasGuard(bootstrap, 'bootstrap')
  ) {
    violations.push(
      'production-bootstrap.yml both jobs must run catalog require-deployable before credentials',
    )
  }
  const bootstrapBuild = shellSource(steps(bootstrap, 'build-production'))
  const bootstrapCredentialed = shellSource(steps(bootstrap, 'bootstrap'))
  for (const [label, source, pattern] of [
    [
      'build command',
      bootstrapBuild,
      /pnpm\s+--filter\s+["']@app\/\$DOMAIN_SERVICE["']\s+run\s+build/,
    ],
    [
      'build verifier',
      bootstrapBuild,
      /verify-worker-artifact\.mjs[\s\S]*--service\s+["']\$DOMAIN_SERVICE["']/,
    ],
    ['tar path', bootstrapBuild, /["']services\/\$DOMAIN_SERVICE\/dist["']/],
    [
      'install verifier',
      bootstrapCredentialed,
      /verify-worker-artifact\.mjs[\s\S]*--service\s+["']\$DOMAIN_SERVICE["']/,
    ],
    [
      'config verifier',
      bootstrapCredentialed,
      /check-production-config\.mjs\s+["']\$DOMAIN_SERVICE["']/,
    ],
    [
      'remote-secret verifier',
      bootstrapCredentialed,
      /check_remote_secret_names\s+["']\$DOMAIN_SERVICE["']/,
    ],
    ['migration', bootstrapCredentialed, /wrangler\s+d1\s+migrations\s+apply\b[\s\S]*--remote/],
    [
      'deploy',
      bootstrapCredentialed,
      /wrangler\s+deploy\s+["']dist\/\$\{\{ inputs\.domain_service \}\}\/index\.js["']/,
    ],
  ]) {
    if (!pattern.test(source))
      violations.push(`production-bootstrap.yml is missing domain ${label}`)
  }
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
