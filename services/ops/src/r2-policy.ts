const API_BASE = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 10_000

function validAccountId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value.trim())
}

function validBucketName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value.trim())
}

async function getJson(fetchImpl: typeof fetch, url: string, token: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('r2_policy_lookup_failed')
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('r2_policy_response_invalid')
  }
  if (!body || typeof body !== 'object' || (body as { success?: unknown }).success !== true) {
    throw new Error('r2_policy_api_unsuccessful')
  }
  return body
}

/**
 * Check the Cloudflare control-plane setting in addition to the R2 binding.
 * A private Worker binding does not disable r2.dev or custom-domain access.
 * This token is read-only and is intentionally separate from D1 export and
 * Worker deploy credentials.
 */
export async function checkR2BucketPrivate(
  accountId: string,
  bucketName: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!validAccountId(accountId)) throw new Error('r2_policy_account_invalid')
  if (!validBucketName(bucketName)) throw new Error('r2_policy_bucket_invalid')
  if (!apiToken.trim()) throw new Error('r2_policy_token_missing')
  const encodedAccount = encodeURIComponent(accountId.trim())
  const encodedBucket = encodeURIComponent(bucketName.trim())
  const managed = await getJson(
    fetchImpl,
    `${API_BASE}/accounts/${encodedAccount}/r2/buckets/${encodedBucket}/domains/managed`,
    apiToken,
  )
  const managedResult =
    managed &&
    typeof managed === 'object' &&
    'result' in managed &&
    managed.result &&
    typeof managed.result === 'object'
      ? (managed.result as { enabled?: unknown })
      : null
  if (managedResult?.enabled !== false) {
    throw new Error('r2_managed_public_access_enabled')
  }

  const custom = await getJson(
    fetchImpl,
    `${API_BASE}/accounts/${encodedAccount}/r2/buckets/${encodedBucket}/domains/custom`,
    apiToken,
  )
  const domains =
    custom && typeof custom === 'object' && 'result' in custom && custom.result
      ? (custom.result as { domains?: unknown }).domains
      : undefined
  if (
    !Array.isArray(domains) ||
    domains.some(
      (domain) =>
        !domain ||
        typeof domain !== 'object' ||
        (domain as { enabled?: unknown }).enabled !== false,
    )
  ) {
    throw new Error('r2_custom_public_access_enabled')
  }
  return true
}
