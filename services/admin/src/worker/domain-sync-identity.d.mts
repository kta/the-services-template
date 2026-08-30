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

export function resolveDomainSyncIdentity(
  environment: Record<string, unknown>,
  identity: DomainSyncIdentity,
): ResolvedDomainSyncIdentity
