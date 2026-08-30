import { Organization } from '@app/contracts'
import type { AppType as ExampleAppType } from '@app/example_service'
import type { Fetcher } from '@cloudflare/workers-types'
import { hc } from 'hono/client'
import { z } from 'zod'
import {
  type DomainSyncIdentity,
  orchestrateDomainSyncIdentities,
  resolveDomainSyncIdentity,
} from './domain-sync-orchestration.mjs'

export type { DomainSyncIdentity } from './domain-sync-orchestration.mjs'
export { resolveDomainSyncIdentity } from './domain-sync-orchestration.mjs'

/**
 * admin → catalog deployable domain の service binding helper。
 * admin は organization(テナント)の源泉で、ドメイン Worker(example_service)の
 * 同期コピーへ upsert する。hourly 照合(reconcile)はドメイン側の同期行一覧を
 * internal GET で読む。TYPED な Hono RPC クライアント(hc)を binding の fetch
 * 経由で使う(internet hop 無し)。
 */

export type SyncEnv = { directory: string; binding: Fetcher; key: string }

const DomainSyncIdentitySchema = z
  .object({
    directory: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    binding: z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/),
    secret: z.string().regex(/^ADMIN_TO_[A-Z][A-Z0-9_]{0,62}_KEY$/),
  })
  .strict()
  .superRefine((identity, context) => {
    const binding = identity.directory.toUpperCase()
    if (identity.binding !== binding) {
      context.addIssue({ code: 'custom', message: `binding must be ${binding}` })
    }
    const secret = `ADMIN_TO_${binding}_KEY`
    if (identity.secret !== secret) {
      context.addIssue({ code: 'custom', message: `secret must be ${secret}` })
    }
  })

const DomainSyncIdentities = z.array(DomainSyncIdentitySchema).max(40)

export function configuredDomainSyncIdentities(
  environment: Record<string, unknown>,
): DomainSyncIdentity[] {
  const serialized = environment.ADMIN_DOMAIN_IDENTITIES
  if (typeof serialized !== 'string') {
    throw new Error('ADMIN_DOMAIN_IDENTITIES must be a reviewed JSON array')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('ADMIN_DOMAIN_IDENTITIES must be a reviewed JSON array')
  }
  const identities = DomainSyncIdentities.parse(parsed)
  if (new Set(identities.map(({ directory }) => directory)).size !== identities.length) {
    throw new Error('ADMIN_DOMAIN_IDENTITIES contains duplicate domains')
  }
  return identities
}

export function configuredDomainSyncEnvironments(environment: Record<string, unknown>): SyncEnv[] {
  const identities = configuredDomainSyncIdentities(environment)
  return identities.map((identity: DomainSyncIdentity) =>
    resolveDomainSyncIdentity(environment, identity),
  )
}

/** A hung service binding must not pin an admin request or hourly Cron forever. */
const SYNC_TIMEOUT_MS = 5_000

function domainClient(env: SyncEnv) {
  return hc<ExampleAppType>('http://example_service', {
    // hc のリクエストを service binding 経由にルーティングする。
    // 二重アサーション: Workers の Fetcher.fetch と、(SPA が AppType を import する
    // 経路で同時に型検査される)DOM の `fetch` は構造的に重ならないため。
    fetch: (input: string | Request | URL, init?: RequestInit) =>
      env.binding.fetch(
        input as never,
        {
          ...init,
          signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
        } as never,
      ) as unknown as Promise<Response>,
    headers: { 'x-internal-key': env.key },
  })
}

/** org を 1 domain の同期コピーへ upsert(best-effort。2xx で true)。 */
export async function syncOrgToDomain(env: SyncEnv, org: Organization): Promise<boolean> {
  try {
    const res = await domainClient(env).api.internal.organizations.$post({ json: org })
    // hc/fetch は非 2xx で reject しない — 同期失敗を観測できるよう status を検査。
    if (!res.ok) console.error('org sync returned non-2xx', res.status, org.id)
    return res.ok
  } catch (err) {
    console.error(`failed to sync organization to ${env.directory}`, err)
    return false
  }
}

export async function syncOrgToConfiguredDomains(
  environment: Record<string, unknown>,
  org: Organization,
): Promise<boolean> {
  let identities: DomainSyncIdentity[]
  try {
    identities = configuredDomainSyncIdentities(environment)
  } catch (error) {
    console.error('failed to parse configured domain sync identities', error)
    return false
  }
  return orchestrateDomainSyncIdentities(
    environment,
    identities,
    (target) => syncOrgToDomain(target, org),
    {
      concurrency: 'parallel',
      onFailure(identity, error) {
        console.error(`failed to resolve domain sync target ${identity.directory}`, error)
      },
    },
  )
}

export async function syncOrgToDomains(
  environments: SyncEnv[],
  org: Organization,
): Promise<boolean> {
  const results = await Promise.all(environments.map((env) => syncOrgToDomain(env, org)))
  return results.every(Boolean)
}

/** domain 側の同期行一覧。失敗は投げる(呼び出し側で処理)。 */
export async function listDomainOrgs(env: SyncEnv): Promise<Organization[]> {
  const res = await domainClient(env).api.internal.organizations.$get()
  if (!res.ok) throw new Error(`${env.directory} organizations ${res.status}`)
  return Organization.array().parse(await res.json())
}
