/**
 * Resolve one catalog-reviewed domain identity against the live Worker
 * environment. This module intentionally has no Worker or TypeScript runtime
 * dependencies so the repository checker can execute the same adapter used by
 * the admin Worker instead of accepting source-text evidence.
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
