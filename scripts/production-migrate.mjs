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
import { requireProductionDomainAuth } from './require-production-domain-auth.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SERVICE_PATTERN = /^[a-z][a-z0-9_]*$/
const DISALLOWED_SERVICES = new Set(['example_service', 'notifier', 'ops'])

function reviewedDatabase(service) {
  if (!SERVICE_PATTERN.test(service) || DISALLOWED_SERVICES.has(service)) {
    throw new Error(`unknown production migration service: ${service}`)
  }
  if (service !== 'admin') requireProductionDomainAuth(service)
  const config = parseJsonc(readFileSync(join(root, `services/${service}/wrangler.jsonc`), 'utf8'))
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

function isMigrationService(service) {
  try {
    reviewedDatabase(service)
    return true
  } catch {
    return false
  }
}

export function productionMigrationCommand(service) {
  const { database } = reviewedDatabase(service)
  return ['d1', 'migrations', 'apply', database, '--remote']
}

function run(script, args, env) {
  execFileSync(process.execPath, [resolve(root, `scripts/${script}`), ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
}

if (process.argv[1]?.endsWith('production-migrate.mjs')) {
  const [service, ...unexpectedArgs] = process.argv.slice(2)
  if (
    !service ||
    unexpectedArgs.length > 0 ||
    !SERVICE_PATTERN.test(service) ||
    DISALLOWED_SERVICES.has(service)
  ) {
    console.error(
      'production migration blocked: usage: production-migrate.mjs <admin> (no Wrangler overrides)',
    )
    process.exitCode = 1
  } else {
    try {
      execFileSync(process.execPath, [resolve(root, 'scripts/require-production-deploy.mjs')], {
        cwd: root,
        // The checkout guard needs only public CI context. Never pass
        // Cloudflare credentials to repository code before the guard returns.
        env: productionStaticEnvironment(process.env),
        stdio: 'inherit',
      })
      if (!isMigrationService(service)) throw new Error('reviewed migration service is invalid')
      const childEnv = productionCloudflareEnvironment(process.env)
      run('check-deploy-boundary.mjs', [], productionStaticEnvironment(process.env))
      run('check-production-config.mjs', [service], childEnv)
      run('check-production-secrets.mjs', [service], childEnv)
      runProductionWrangler(
        productionMigrationCommand(service),
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
      process.exitCode = error?.status ?? 1
    }
  }
}
