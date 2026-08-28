#!/usr/bin/env node

// Wrangler reads several environment variables that can replace the reviewed
// config or API destination. Production entry points keep only the two
// credentials explicitly supplied by the protected workflow and a small,
// explicit execution environment. In particular, proxy, npm, Git, Node,
// Wrangler, and arbitrary CI token variables must not flow into a production
// child process.
const ALLOWED_ENV = new Set([
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
  'PRODUCTION_ENVIRONMENT',
])
const ALLOWED_CLOUDFLARE_ENV = new Set(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])
const ALLOWED_CLOUDFLARE_CHILD_ENV = new Set([
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
])

export function productionEnvironment(environment) {
  const sanitized = {}
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (ALLOWED_CLOUDFLARE_ENV.has(name) || ALLOWED_ENV.has(name)) sanitized[name] = value
  }
  return sanitized
}

export function productionCloudflareEnvironment(environment) {
  const sanitized = {}
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (ALLOWED_CLOUDFLARE_ENV.has(name) || ALLOWED_CLOUDFLARE_CHILD_ENV.has(name)) {
      sanitized[name] = value
    }
  }
  return sanitized
}

/** Static repository/config checks never need Cloudflare credentials. */
export function productionStaticEnvironment(environment) {
  const sanitized = productionCloudflareEnvironment(environment)
  delete sanitized.CLOUDFLARE_API_TOKEN
  delete sanitized.CLOUDFLARE_ACCOUNT_ID
  return sanitized
}
