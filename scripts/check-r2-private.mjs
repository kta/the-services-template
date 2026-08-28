#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveValues, parseJsonc } from './check-production-config.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const API_BASE = 'https://api.cloudflare.com/client/v4'

function validAccountId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value.trim())
}

function validBucketName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value.trim())
}

async function getJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('R2 public-access policy lookup failed')
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error('R2 public-access policy response is invalid')
  }
  if (!body || typeof body !== 'object' || body.success !== true) {
    throw new Error('R2 public-access policy API response was unsuccessful')
  }
  return body
}

/**
 * Verify both R2 public access surfaces. The Wrangler binding being private
 * does not disable an independently configured r2.dev or custom domain.
 */
export async function checkR2BucketPrivate(accountId, bucketName, apiToken, fetchImpl = fetch) {
  if (!validAccountId(accountId)) throw new Error('Cloudflare account id is invalid')
  if (!validBucketName(bucketName)) throw new Error('R2 bucket name is invalid')
  if (typeof apiToken !== 'string' || apiToken.trim() === '') {
    throw new Error('Cloudflare API token is missing')
  }
  const encodedAccount = encodeURIComponent(accountId.trim())
  const encodedBucket = encodeURIComponent(bucketName.trim())
  const managed = await getJson(
    fetchImpl,
    `${API_BASE}/accounts/${encodedAccount}/r2/buckets/${encodedBucket}/domains/managed`,
    apiToken,
  )
  if (managed?.result?.enabled !== false) {
    throw new Error('R2 managed r2.dev public access must be disabled')
  }
  const custom = await getJson(
    fetchImpl,
    `${API_BASE}/accounts/${encodedAccount}/r2/buckets/${encodedBucket}/domains/custom`,
    apiToken,
  )
  const domains = custom?.result?.domains
  if (!Array.isArray(domains) || domains.some((domain) => domain?.enabled !== false)) {
    throw new Error('all R2 custom domains must have public access disabled')
  }
  return true
}

export function assertRuntimeAccountMatchesConfig(configAccountId, runtimeAccountId) {
  const runtime = typeof runtimeAccountId === 'string' ? runtimeAccountId.trim() : ''
  if (runtime && runtime !== String(configAccountId).trim()) {
    throw new Error('Cloudflare runtime account does not match ops configuration')
  }
  return true
}

if (process.argv[1]?.endsWith('check-r2-private.mjs')) {
  try {
    const config = parseJsonc(readFileSync(join(root, 'services/ops/wrangler.jsonc'), 'utf8'))
    const values = effectiveValues(config)
    assertRuntimeAccountMatchesConfig(values.opsAccountId, process.env.CLOUDFLARE_ACCOUNT_ID)
    await checkR2BucketPrivate(
      values.opsAccountId,
      values.opsBucketName,
      process.env.CLOUDFLARE_API_TOKEN,
    )
    console.log('R2 backup bucket public access: disabled')
  } catch (error) {
    console.error(
      `R2 privacy preflight blocked: ${error instanceof Error ? error.message : 'validation failed'}`,
    )
    process.exitCode = 1
  }
}
