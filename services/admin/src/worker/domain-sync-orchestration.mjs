/**
 * Resolve one catalog-reviewed domain identity against the live Worker
 * environment. Keeping resolution and iteration in this executable module
 * makes the checker exercise the same boundary as request and Cron paths.
 */
export function resolveDomainSyncIdentity(environment, identity) {
  const binding = environment[identity.binding]
  if (!binding || typeof binding !== 'object' || typeof binding.fetch !== 'function') {
    throw new Error(`${identity.binding} must resolve to a service Fetcher`)
  }
  const secret = environment[identity.secret]
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`${identity.secret} must resolve to a caller key`)
  }
  return { directory: identity.directory, binding, key: secret }
}

async function reportFailure(identity, error, onFailure) {
  if (typeof onFailure !== 'function') return
  try {
    await onFailure(identity, error)
  } catch (reportingError) {
    console.error(
      `failed to report domain orchestration failure for ${identity.directory}`,
      reportingError,
    )
  }
}

/**
 * Execute a request sync or scheduled reconcile over catalog-derived domain
 * identities. Resolution and the operation share one per-domain try/catch, so
 * a missing binding/secret or a rejected fetch never prevents later domains.
 */
export async function orchestrateDomainSyncIdentities(
  environment,
  identities,
  operation,
  options = {},
) {
  if (!Array.isArray(identities) || typeof operation !== 'function') {
    throw new Error('domain orchestration requires identities and an operation')
  }
  const concurrency = options.concurrency ?? 'parallel'
  if (concurrency !== 'parallel' && concurrency !== 'sequential') {
    throw new Error('domain orchestration concurrency must be parallel or sequential')
  }

  const invoke = async (identity) => {
    try {
      const target = resolveDomainSyncIdentity(environment, identity)
      return (await operation(target, identity)) !== false
    } catch (error) {
      await reportFailure(identity, error, options.onFailure)
      return false
    }
  }

  if (concurrency === 'sequential') {
    const results = []
    for (const identity of identities) results.push(await invoke(identity))
    return results.every(Boolean)
  }
  return (await Promise.all(identities.map(invoke))).every(Boolean)
}
