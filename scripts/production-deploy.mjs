#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProductionWrangler } from './production-wrangler.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SERVICE_PATTERN = /^[a-z][a-z0-9_]*$/
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

/**
 * The template has three fixed platform Workers and any forked domain Worker.
 * A domain name is accepted only when the repository contains the two reviewed
 * service files; `check-deploy-boundary.mjs` then verifies all cross-service
 * wiring before Wrangler is reached.
 */
export function isProductionService(service) {
  if (!SERVICE_PATTERN.test(service) || service === 'example_service') return false
  const serviceDir = resolve(root, `services/${service}`)
  return (
    existsSync(join(serviceDir, 'package.json')) && existsSync(join(serviceDir, 'wrangler.jsonc'))
  )
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [service, ...args] = process.argv.slice(2)
  if (!isProductionService(service) || args.length > 0) {
    const overrides = forbiddenProductionDeployArgs(args)
    fail(
      overrides.length > 0
        ? `Wrangler overrides are not accepted (${overrides.join(', ')})`
        : 'production deploy accepts only the service name; edit reviewed configuration instead',
    )
  } else {
    const serviceDir = resolve(root, `services/${service}`)
    try {
      // Establish checkout trust before any credential-bearing environment is
      // constructed or any repository helper is executed. The guard only
      // receives only public CI context, never Cloudflare credentials.
      execFileSync(process.execPath, [resolve(root, 'scripts/require-production-deploy.mjs')], {
        cwd: root,
        stdio: 'inherit',
        env: publicGuardEnvironment(process.env),
      })
      const { productionCloudflareEnvironment, productionStaticEnvironment } = await import(
        './production-environment.mjs'
      )
      const { requireProductionDomainAuth } = await import('./require-production-domain-auth.mjs')
      const { buildWorkerArtifactManifest } = await import('./verify-worker-artifact.mjs')
      if (!['admin', 'notifier', 'ops'].includes(service)) {
        requireProductionDomainAuth(service)
      }
      requirePrebuiltOutput(service, serviceDir)
      // Guard direct Make/operator deployments as well as CI artifact installs:
      // every deployable Worker output must be regular, complete, and free of
      // private-key material before a credentialed Wrangler process starts.
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
      process.exitCode = error?.status ?? 1
    }
  }
}
