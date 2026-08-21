import { Organization } from '@app/contracts'
import type { AppType as ExampleAppType } from '@app/example_service'
import type { Fetcher } from '@cloudflare/workers-types'
import { hc } from 'hono/client'

/**
 * admin → example_service の service binding ヘルパ。
 * admin は organization(テナント)の源泉で、ドメイン Worker(example_service)の
 * 同期コピーへ upsert する。日次照合(reconcile)はドメイン側の同期行一覧を
 * internal GET で読む。TYPED な Hono RPC クライアント(hc)を binding の fetch
 * 経由で使う(internet hop 無し)。
 */

export type SyncEnv = { EXAMPLE_SERVICE: Fetcher; INTERNAL_KEY: string }

function domainClient(env: SyncEnv) {
  return hc<ExampleAppType>('http://example_service', {
    // hc のリクエストを service binding 経由にルーティングする。
    // 二重アサーション: Workers の Fetcher.fetch と、(SPA が AppType を import する
    // 経路で同時に型検査される)DOM の `fetch` は構造的に重ならないため。
    fetch: env.EXAMPLE_SERVICE.fetch.bind(env.EXAMPLE_SERVICE) as unknown as typeof fetch,
    headers: { 'x-internal-key': env.INTERNAL_KEY },
  })
}

/** org を example_service の同期コピーへ upsert(best-effort。2xx で true)。 */
export async function syncOrgToExampleService(env: SyncEnv, org: Organization): Promise<boolean> {
  try {
    const res = await domainClient(env).api.internal.organizations.$post({ json: org })
    // hc/fetch は非 2xx で reject しない — 同期失敗を観測できるよう status を検査。
    if (!res.ok) console.error('org sync returned non-2xx', res.status, org.id)
    return res.ok
  } catch (err) {
    console.error('failed to sync organization', err)
    return false
  }
}

/** ドメイン側(example_service)の同期行一覧。失敗は投げる(呼び出し側で処理)。 */
export async function listDomainOrgs(env: SyncEnv): Promise<Organization[]> {
  const res = await domainClient(env).api.internal.organizations.$get()
  if (!res.ok) throw new Error(`example_service organizations ${res.status}`)
  return Organization.array().parse(await res.json())
}
