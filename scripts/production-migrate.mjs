#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveValues, parseJsonc } from './check-production-config.mjs'
import {
  productionCloudflareEnvironment,
  productionStaticEnvironment,
} from './production-environment.mjs'
import { runProductionWrangler } from './production-wrangler.mjs'
import {
  loadServiceRepositoryCatalog,
  requireCatalogDeployableService,
} from './service-catalog.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SERVICE_PATTERN = /^[a-z][a-z0-9_]*$/

function reviewedDatabase(service, catalog, rootDirectory = root) {
  requireCatalogDeployableService(catalog, service, { spa: true })
  const config = parseJsonc(
    readFileSync(join(rootDirectory, `services/${service}/wrangler.jsonc`), 'utf8'),
  )
  const values = effectiveValues(config)
  if (
    typeof values.databaseName !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,62}$/.test(values.databaseName)
  ) {
    throw new Error(`production migration ${service} is missing a configured D1 name`)
  }
  // Use the reviewed DB binding rather than a caller-supplied database name.
  // check-production-config runs immediately before this command and verifies
  // that the binding contains a concrete database_id.
  return { database: 'DB', databaseId: values.adminDatabaseId }
}

export async function productionMigrationCommand(service, rootDirectory = root, catalog) {
  const reviewedCatalog = catalog ?? (await loadServiceRepositoryCatalog(rootDirectory))
  const { database } = reviewedDatabase(service, reviewedCatalog, rootDirectory)
  return ['d1', 'migrations', 'apply', database, '--remote']
}

function run(script, args, env) {
  execFileSync(process.execPath, [resolve(root, `scripts/${script}`), ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
}

async function main() {
  const [service, ...unexpectedArgs] = process.argv.slice(2)
  if (!service || unexpectedArgs.length > 0 || !SERVICE_PATTERN.test(service)) {
    console.error(
      'production migration blocked: usage: production-migrate.mjs <admin> (no Wrangler overrides)',
    )
    process.exitCode = 1
    return
  }
  try {
    execFileSync(process.execPath, [resolve(root, 'scripts/require-production-deploy.mjs')], {
      cwd: root,
      // The checkout guard needs only public CI context. Never pass
      // Cloudflare credentials to repository code before the guard returns.
      env: productionStaticEnvironment(process.env),
      stdio: 'inherit',
    })
    const catalog = await loadServiceRepositoryCatalog(root)
    requireCatalogDeployableService(catalog, service, { spa: true })
    if (service !== 'admin') {
      const { requireProductionDomainAuth } = await import('./require-production-domain-auth.mjs')
      requireProductionDomainAuth(service, root, catalog)
    }
    const childEnv = productionCloudflareEnvironment(process.env)
    run('check-deploy-boundary.mjs', [], productionStaticEnvironment(process.env))
    run('check-production-config.mjs', [service], childEnv)
    run('check-production-secrets.mjs', [service], childEnv)
    runProductionWrangler(
      await productionMigrationCommand(service, root, catalog),
      {
        cwd: resolve(root, `services/${service}`),
        env: childEnv,
        stdio: 'inherit',
        timeout: 15 * 60 * 1_000,
        killSignal: 'SIGTERM',
      },
      process.env,
    )
  } catch (error) {
    console.error(
      `production migration blocked: ${error instanceof Error ? error.message : 'failure'}`,
    )
    process.exitCode = error?.status ?? 1
  }
}

if (process.argv[1]?.endsWith('production-migrate.mjs')) await main()
