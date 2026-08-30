import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

function unique(values) {
  return [...new Set(values)]
}

function compareSet(label, expectedValues, actualValues, violations) {
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

export function validateServiceWiringSources(catalog, sources) {
  const violations = []
  const spaDirectories = catalog.services.map((service) => service.directory)
  const spaPackages = catalog.services.map((service) => service.package)
  const productionDirectories = [
    ...catalog.services.filter((service) => service.deployable).map((service) => service.directory),
    ...catalog.workerOnlyServices,
  ]
  const productionPackages = productionDirectories.map((directory) => `@app/${directory}`)

  const devServices =
    sources.makefile
      .match(/^DEV_ALL_SERVICES\s*:=\s*(.*)$/m)?.[1]
      ?.trim()
      .split(/\s+/)
      .filter(Boolean) ?? []
  compareSet('DEV_ALL_SERVICES', spaDirectories, devServices, violations)

  let packageJson
  try {
    packageJson = JSON.parse(sources.packageJson)
  } catch (error) {
    violations.push(`root package.json has malformed JSON: ${error.message}`)
    packageJson = {}
  }
  const combinedPackages = unique(
    [
      ...(packageJson.scripts?.test ?? '').matchAll(
        /pnpm --filter (@app\/[a-z][a-z0-9_]*) test:all\b/g,
      ),
    ].map((match) => match[1]),
  )
  compareSet('root combined SPA test', spaPackages, combinedPackages, violations)

  const e2eDirectories = unique(
    [
      ...sources.ci.matchAll(
        /\{\s*name:\s*([a-z][a-z0-9_]*),\s*pkg:\s*'(@app\/[a-z][a-z0-9_]*)',\s*dir:\s*services\/([a-z][a-z0-9_]*)\s*\}/g,
      ),
    ]
      .filter((match) => match[1] === match[3] && match[2] === `@app/${match[1]}`)
      .map((match) => match[1]),
  )
  compareSet('manual E2E matrix', spaDirectories, e2eDirectories, violations)

  const buildStart = sources.ci.indexOf('\n  build-production:')
  const deployStart = sources.ci.indexOf('\n  deploy:', buildStart)
  const buildJob =
    buildStart >= 0 ? sources.ci.slice(buildStart, deployStart < 0 ? undefined : deployStart) : ''
  const deployJob = deployStart >= 0 ? sources.ci.slice(deployStart) : ''
  const buildPackages = unique(
    [...buildJob.matchAll(/pnpm --filter (@app\/[a-z][a-z0-9_]*) run build\b/g)].map(
      (match) => match[1],
    ),
  )
  compareSet('production build', productionPackages, buildPackages, violations)
  const artifactServices = unique(
    [...buildJob.matchAll(/--service\s+([a-z][a-z0-9_]*)/g)].map((match) => match[1]),
  )
  compareSet('production artifact', productionDirectories, artifactServices, violations)
  const deployServices = unique(
    [...deployJob.matchAll(/- name:\s*Deploy\s+([a-z][a-z0-9_]*)/g)].map((match) => match[1]),
  )
  compareSet('production deploy', productionDirectories, deployServices, violations)

  if (!/loadServiceRepositoryCatalog/.test(sources.productionChecker)) {
    violations.push('production checker must consume the validated service catalog')
  }
  return violations
}

export async function validateServiceWiring(root, catalog) {
  const [makefile, packageJson, ci, productionChecker] = await Promise.all([
    readFile(join(root, 'Makefile'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(join(root, '.github/workflows/ci.yml'), 'utf8'),
    readFile(join(root, 'scripts/check-deploy-boundary.mjs'), 'utf8'),
  ])
  return validateServiceWiringSources(catalog, { makefile, packageJson, ci, productionChecker })
}
