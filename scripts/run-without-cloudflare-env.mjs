#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

// A build is deliberately credentialless. Keep an explicit, small execution
// environment instead of blacklisting today's known secret names: a newly
// introduced PRODUCTION_* / *_TOKEN / *_KEY variable must not silently reach
// Vite or Wrangler. Test-only credentials are allowed only for the explicit
// E2E build mode used by Playwright.
const SAFE_ENVIRONMENT = new Set([
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
  'GITHUB_WORKFLOW_REF',
  'GITHUB_RUN_ID',
  'APP_ENV',
])
const E2E_ENVIRONMENT = new Set([
  'E2E_AUTH',
  'E2E_STATE_PATH',
  'E2E_FIXTURE_CONTROL_TOKEN',
  'E2E_FIXTURE_INTERNAL_KEY',
  'AUTH_DEV_GRANT',
  'AUTH_DEV_PRIVATE_KEY',
  'AUTH_PEPPER',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'DOMAIN_TO_ADMIN_KEY',
  'ADMIN_TO_EXAMPLE_SERVICE_KEY',
  'ADMIN_TO_NOTIFIER_KEY',
  'DOMAIN_TO_NOTIFIER_KEY',
])
const PUBLIC_BUILD_VARIABLE = /^VITE_PUBLIC_[A-Z0-9_]+$/

export function withoutCloudflareEnvironment(environment) {
  const e2eMode = environment?.E2E_AUTH === 'true'
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter(
      ([name]) =>
        SAFE_ENVIRONMENT.has(name) ||
        PUBLIC_BUILD_VARIABLE.test(name) ||
        (e2eMode && E2E_ENVIRONMENT.has(name)),
    ),
  )
}

if (process.argv[1]?.endsWith('run-without-cloudflare-env.mjs')) {
  const [command, ...args] = process.argv.slice(2)
  if (!command) {
    console.error('usage: run-without-cloudflare-env.mjs <command> [args...]')
    process.exitCode = 2
  } else {
    try {
      execFileSync(command, args, {
        cwd: process.cwd(),
        env: withoutCloudflareEnvironment(process.env),
        stdio: 'inherit',
      })
    } catch (error) {
      process.exitCode = error?.status ?? 1
    }
  }
}
