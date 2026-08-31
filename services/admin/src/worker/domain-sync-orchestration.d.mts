import type { Fetcher } from '@cloudflare/workers-types'

export type DomainSyncIdentity = {
  directory: string
  binding: string
  secret: string
}

export type ResolvedDomainSyncIdentity = {
  directory: string
  binding: Fetcher
  key: string
}

export type DomainSyncOperation = (
  target: ResolvedDomainSyncIdentity,
  identity: DomainSyncIdentity,
) => unknown | Promise<unknown>

export type DomainSyncOrchestrationOptions = {
  concurrency?: 'parallel' | 'sequential'
  onFailure?: (identity: DomainSyncIdentity, error: unknown) => void | Promise<void>
}

export function resolveDomainSyncIdentity(
  environment: Record<string, unknown>,
  identity: DomainSyncIdentity,
): ResolvedDomainSyncIdentity

export function orchestrateDomainSyncIdentities(
  environment: Record<string, unknown>,
  identities: DomainSyncIdentity[],
  operation: DomainSyncOperation,
  options?: DomainSyncOrchestrationOptions,
): Promise<boolean>
