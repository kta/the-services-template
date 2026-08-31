#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProductionWrangler } from './production-wrangler.mjs'
import {
  loadServiceRepositoryCatalog,
  requireCatalogDeployableService,
} from './service-catalog.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PUBLIC_GUARD_ENVIRONMENT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'NO_COLOR',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_EVENT_NAME',
  'GITHUB_REF',
  'GITHUB_REF_PROTECTED',
  'GITHUB_SHA',
  'GITHUB_REPOSITORY',
])

function publicGuardEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter(([name]) => PUBLIC_GUARD_ENVIRONMENT.has(name)),
  )
}

export async function isProductionService(service, rootDirectory = root) {
  try {
    const catalog = await loadServiceRepositoryCatalog(rootDirectory)
    requireCatalogDeployableService(catalog, service)
    return true
  } catch {
    return false
  }
}

// Production deploys intentionally expose no Wrangler override surface. An
// operator must change the reviewed wrangler.jsonc/CI environment instead of
// smuggling a different account, worker, config, or secret source through CLI.
export function forbiddenProductionDeployArgs(args) {
  const forbidden = [
    '--env',
    '--var',
    '--define',
    '--secrets-file',
    '--keep-vars',
    '--config',
    '--cwd',
    '--name',
    '--compatibility-date',
    '--assets',
    '--outdir',
    '--no-bundle',
  ]
  return args.filter((arg) =>
    forbidden.some((option) => arg === option || arg.startsWith(`${option}=`)),
  )
}

/**
 * Build output is created in a credentialless job (or by the guarded Make
 * target) and is uploaded here with Wrangler's no-bundle mode. This keeps the
 * process that can see production credentials from compiling repository code.
 * Vite Workers use dist/<service>/index.js + dist/client; plain Workers use
 * dist/index.js.
 */
export function productionDeployCommand(service) {
  const viteWorker = service !== 'notifier' && service !== 'ops'
  const entry = viteWorker ? `dist/${service}/index.js` : 'dist/index.js'
  const args = ['deploy', entry, '--no-bundle', '--config=wrangler.jsonc']
  if (viteWorker) args.push('--assets=dist/client')
  return args
}

function requirePrebuiltOutput(service, serviceDir) {
  const entry =
    service !== 'notifier' && service !== 'ops' ? `dist/${service}/index.js` : 'dist/index.js'
  if (!existsSync(join(serviceDir, entry))) {
    throw new Error(
      `missing prebuilt Worker output: ${service}/${entry}; run the credentialless build first`,
    )
  }
  if (service !== 'notifier' && service !== 'ops' && !existsSync(join(serviceDir, 'dist/client'))) {
    throw new Error(`missing prebuilt static assets: ${service}/dist/client`)
  }
}

function fail(message) {
  console.error(`production deploy blocked: ${message}`)
  process.exitCode = 1
}

async function main() {
  const [service, ...args] = process.argv.slice(2)
  if (!service || args.length > 0) {
    const overrides = forbiddenProductionDeployArgs(args)
    fail(
      overrides.length > 0
        ? `Wrangler overrides are not accepted (${overrides.join(', ')})`
        : 'production deploy accepts only the service name; edit reviewed configuration instead',
    )
    return
  }
  try {
    // Establish checkout trust before parsing repository-controlled catalog or
    // resolving any credential-bearing child process.
    execFileSync(process.execPath, [resolve(root, 'scripts/require-production-deploy.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: publicGuardEnvironment(process.env),
    })
    const catalog = await loadServiceRepositoryCatalog(root)
    requireCatalogDeployableService(catalog, service)
    const serviceDir = resolve(root, `services/${service}`)
    const { productionCloudflareEnvironment, productionStaticEnvironment } = await import(
      './production-environment.mjs'
    )
    const { requireProductionDomainAuth } = await import('./require-production-domain-auth.mjs')
    const { buildWorkerArtifactManifest, requireCatalogWorkerArtifactServices } = await import(
      './verify-worker-artifact.mjs'
    )
    if (!['admin', 'notifier', 'ops'].includes(service)) {
      requireProductionDomainAuth(service, root, catalog)
    }
    requirePrebuiltOutput(service, serviceDir)
    // Guard direct Make/operator deployments as well as CI artifact installs:
    // every deployable Worker output must be regular, complete, and free of
    // private-key material before a credentialed Wrangler process starts.
    requireCatalogWorkerArtifactServices(catalog, [service])
    buildWorkerArtifactManifest(root, [service])
    execFileSync(process.execPath, [resolve(root, 'scripts/check-deploy-boundary.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: productionStaticEnvironment(process.env),
    })
    const childEnv = productionCloudflareEnvironment(process.env)
    execFileSync(
      process.execPath,
      [resolve(root, 'scripts/check-production-config.mjs'), service],
      {
        cwd: root,
        stdio: 'inherit',
        env: childEnv,
      },
    )
    execFileSync(
      process.execPath,
      [resolve(root, 'scripts/check-production-secrets.mjs'), service],
      {
        cwd: root,
        stdio: 'inherit',
        env: childEnv,
      },
    )
    if (service === 'ops') {
      execFileSync(process.execPath, [resolve(root, 'scripts/check-r2-private.mjs')], {
        cwd: root,
        stdio: 'inherit',
        env: childEnv,
      })
    }
    runProductionWrangler(
      productionDeployCommand(service),
      {
        cwd: serviceDir,
        stdio: 'inherit',
        env: childEnv,
        timeout: 15 * 60 * 1_000,
        killSignal: 'SIGTERM',
      },
      process.env,
    )
  } catch (error) {
    console.error(
      `production deploy blocked: ${error instanceof Error ? error.message : 'failure'}`,
    )
    process.exitCode = error?.status ?? 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
