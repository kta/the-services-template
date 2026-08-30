#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  productionCloudflareEnvironment,
  productionEnvironment,
  productionGuardEnvironment,
} from './production-environment.mjs'
import { resolveProductionPnpm, resolveReviewedNode } from './production-pnpm.mjs'
import { withoutCloudflareEnvironment } from './run-without-cloudflare-env.mjs'
import { loadServiceRepositoryCatalog } from './service-catalog.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CREDENTIAL_ACTIONS = new Set(['migrate', 'deploy', 'bootstrap'])

function guardScriptForAction(action, environment) {
  if (action === 'bootstrap') return 'require-production-bootstrap.mjs'
  if (action === 'migrate' && environment?.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    return 'require-production-bootstrap.mjs'
  }
  return 'require-production-deploy.mjs'
}

function requireCredentialedActionGuard(root, action, environment, nodePath, run = execFileSync) {
  if (!CREDENTIAL_ACTIONS.has(action)) return
  run(nodePath, [join(root, 'scripts', guardScriptForAction(action, environment))], {
    cwd: root,
    env: productionServiceGuardEnvironment(environment, nodePath),
    stdio: 'inherit',
  })
}

function catalogEntry(catalog, directory) {
  if (typeof directory !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(directory)) {
    throw new Error(`${String(directory)} is not a catalog deployable service`)
  }
  const entries = [...(catalog.services ?? []), ...(catalog.workerOnlyServices ?? [])]
  const service = entries.find((candidate) => candidate.directory === directory)
  if (service?.deployable !== true || service.package !== `@app/${directory}`) {
    throw new Error(`${directory} is not a catalog deployable service`)
  }
  return service
}

function trustedPnpm(options) {
  if (
    typeof options.pnpmPath !== 'string' ||
    !isAbsolute(options.pnpmPath) ||
    !/^pnpm(?:\.c?js)?$/.test(basename(options.pnpmPath))
  ) {
    throw new Error('credentialed production action requires a trusted absolute pnpm path')
  }
  return options.pnpmPath
}

function trustedNode(options) {
  const path = options.nodePath ?? process.execPath
  if (typeof path !== 'string' || !isAbsolute(path) || !/^node(?:\.exe)?$/.test(basename(path))) {
    throw new Error('production action requires a trusted absolute Node path')
  }
  return path
}

function reviewedToolPath(options) {
  const directories = [dirname(trustedNode(options)), dirname(trustedPnpm(options))]
  for (const directory of ['/usr/local/bin', '/usr/bin', '/bin']) {
    if (!directories.includes(directory)) directories.push(directory)
  }
  return directories.join(delimiter)
}

export function productionServiceGuardEnvironment(environment, nodePath) {
  const child = productionGuardEnvironment(environment)
  trustedNode({ nodePath })
  // The guard invokes Node by absolute path and needs only the system Git.
  // Excluding package-manager and user-owned tool directories prevents a
  // PATH shim from fabricating the reviewed checkout state.
  child.PATH = ['/usr/bin', '/bin'].join(delimiter)
  return child
}

export function productionServiceChildEnvironment(action, environment, options) {
  let child
  if (action === 'build') child = withoutCloudflareEnvironment(environment)
  else if (action === 'config') {
    child = productionEnvironment(environment)
    delete child.CLOUDFLARE_API_TOKEN
  } else if (action === 'remote-secrets' || action === 'remote-secrets-bootstrap') {
    child = productionEnvironment(environment)
  } else if (CREDENTIAL_ACTIONS.has(action)) {
    child = productionCloudflareEnvironment(environment)
  } else {
    child = productionGuardEnvironment(environment)
  }
  child.PATH = reviewedToolPath(options)
  return child
}

function wranglerInvocation(root, service, args, options) {
  return {
    command: trustedPnpm(options),
    args: ['--config.offline=true', 'exec', 'wrangler', ...args],
    cwd: join(root, 'services', service.directory),
  }
}

function bootstrapSecretPath(service, options) {
  if (typeof options.runnerTemp !== 'string' || !isAbsolute(options.runnerTemp)) {
    throw new Error('bootstrap requires an absolute RUNNER_TEMP')
  }
  const kind = ['admin', 'notifier', 'ops'].includes(service.directory)
    ? service.directory
    : 'domain'
  return join(resolve(options.runnerTemp), 'production-secret-bundles', `${kind}.json`)
}

export function productionServiceInvocation(
  workspaceRoot,
  catalog,
  directory,
  action,
  options = {},
) {
  const root = resolve(workspaceRoot)
  const service = catalogEntry(catalog, directory)
  const spa = (catalog.services ?? []).some((candidate) => candidate.directory === directory)

  switch (action) {
    case 'guard-domain':
      if (!spa || directory === 'admin') {
        throw new Error(`${directory} is not a copied domain service`)
      }
      return {
        command: trustedNode(options),
        args: [join(root, 'scripts/require-production-domain-auth.mjs'), directory],
        cwd: root,
      }
    case 'build':
      return {
        command: trustedPnpm(options),
        args: ['--filter', service.package, 'run', 'build'],
        cwd: root,
      }
    case 'config':
      return {
        command: trustedNode(options),
        args: [join(root, 'scripts/check-production-config.mjs'), directory],
        cwd: root,
      }
    case 'remote-secrets':
    case 'remote-secrets-bootstrap':
      return {
        command: trustedNode(options),
        args: [
          join(root, 'scripts/check-production-secrets.mjs'),
          directory,
          action === 'remote-secrets-bootstrap' ? '--allow-missing-worker' : '--deploy',
        ],
        cwd: root,
      }
    case 'migrate':
      if (!spa) throw new Error(`${directory}: migration requires a catalog SPA service`)
      return wranglerInvocation(
        root,
        service,
        ['d1', 'migrations', 'apply', 'DB', '--remote', '--config=wrangler.jsonc'],
        options,
      )
    case 'deploy':
    case 'bootstrap': {
      const entry = spa ? `dist/${directory}/index.js` : 'dist/index.js'
      const args = ['deploy', entry, '--no-bundle', '--config=wrangler.jsonc']
      if (spa) args.push('--assets=dist/client')
      if (action === 'bootstrap') {
        args.push(`--secrets-file=${bootstrapSecretPath(service, options)}`)
      }
      return wranglerInvocation(root, service, args, options)
    }
    default:
      throw new Error(`unknown production service action: ${String(action)}`)
  }
}

function isInside(root, path) {
  const relation = relative(root, path)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

function verifyBootstrapSecretFile(invocation, runnerTemp) {
  const option = invocation.args.find((arg) => arg.startsWith('--secrets-file='))
  if (!option) return
  const path = option.slice('--secrets-file='.length)
  const allowedRoot = realpathSync(resolve(runnerTemp, 'production-secret-bundles'))
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || !isInside(allowedRoot, realpathSync(path))) {
    throw new Error('bootstrap secret file must be a contained regular file')
  }
}

async function main() {
  const [directory, action, ...extra] = process.argv.slice(2)
  if (!directory || !action || extra.length > 0) {
    throw new Error('usage: production-service.mjs <catalog-service> <action>')
  }
  // Establish the protected checkout boundary before catalog validation can
  // spawn its YAML parser or any credential-bearing helper can be resolved.
  const nodePath = resolveReviewedNode(process.execPath, DEFAULT_ROOT)
  requireCredentialedActionGuard(DEFAULT_ROOT, action, process.env, nodePath)
  const catalog = await loadServiceRepositoryCatalog(DEFAULT_ROOT)
  const options = {
    nodePath,
    pnpmPath: resolveProductionPnpm(process.env, DEFAULT_ROOT),
  }
  if (action === 'bootstrap') options.runnerTemp = process.env.RUNNER_TEMP
  const invocation = productionServiceInvocation(DEFAULT_ROOT, catalog, directory, action, options)
  if (action === 'bootstrap') verifyBootstrapSecretFile(invocation, options.runnerTemp)
  execFileSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: productionServiceChildEnvironment(action, process.env, options),
    stdio: 'inherit',
    timeout: 20 * 60 * 1_000,
    killSignal: 'SIGTERM',
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `production service workflow blocked: ${error instanceof Error ? error.message : 'failure'}`,
    )
    process.exitCode = error?.status ?? 1
  })
}
