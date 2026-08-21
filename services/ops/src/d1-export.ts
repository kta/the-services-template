/**
 * D1 REST export(polling)クライアント。D1 は binding 経由で export できないため
 * REST API を使う。export は当該 DB をブロックするため Cron は JST 深夜/昼に固定。
 * トークンは D1:Read のみに絞る(secrets)。
 *
 * 契約(Cloudflare D1 export API・polling):
 *  1) POST /accounts/{acct}/d1/database/{db}/export  body {output_format:'polling'}
 *     → { result: { at_bookmark, status:'processing'|'complete', result?, error? } }
 *  2) 同 endpoint に body {output_format:'polling', current_bookmark} で status=complete
 *     まで polling → result.signed_url を得る
 *  3) signed_url を GET して SQL ダンプ本文を取得
 *
 * fetch は注入可能(テストでモック)。
 */

export type D1ExportConfig = {
  accountId: string
  databaseId: string
  apiToken: string
}

type ExportResult = {
  at_bookmark?: string
  status?: 'processing' | 'complete' | string
  result?: { signed_url?: string; filename?: string }
  error?: string
}

const API_BASE = 'https://api.cloudflare.com/client/v4'
const MAX_POLLS = 30
// polling は間隔を空ける(即時連打だと大きな DB の export が MAX_POLLS 回の往復で
// 数秒しか待てず spurious timeout になる。30 回 × 2s = 最大 60 秒待てる)。
const POLL_INTERVAL_MS = 2_000

type SleepImpl = (ms: number) => Promise<void>
const defaultSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** export を開始し complete まで polling → signed_url から SQL 本文を返す。 */
export async function exportD1Dump(
  cfg: D1ExportConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: SleepImpl = defaultSleep,
): Promise<string> {
  const url = `${API_BASE}/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/export`
  const headers = {
    authorization: `Bearer ${cfg.apiToken}`,
    'content-type': 'application/json',
  }

  const first = await postExport(fetchImpl, url, headers, { output_format: 'polling' })
  let state = first
  let polls = 0
  while (state.status !== 'complete') {
    if (polls++ >= MAX_POLLS) throw new Error('export_timeout')
    if (state.status && state.status !== 'processing') {
      throw new Error(`export_failed:${state.error ?? state.status}`)
    }
    await sleepImpl(POLL_INTERVAL_MS)
    state = await postExport(fetchImpl, url, headers, {
      output_format: 'polling',
      current_bookmark: state.at_bookmark,
    })
  }

  const signed = state.result?.signed_url
  if (!signed) throw new Error('export_no_url')
  const dumpRes = await fetchImpl(signed)
  if (!dumpRes.ok) throw new Error(`export_download_${dumpRes.status}`)
  return dumpRes.text()
}

/**
 * D1 の使用バイト数を取得(容量監視用)。REST の「Get database」
 * `GET /accounts/{acct}/d1/database/{db}` → `result.file_size`(バイト)を返す。
 * D1:Read トークンで叩ける。fetch は注入可能(テストでモック)。
 */
export async function fetchD1FileSize(
  cfg: D1ExportConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const url = `${API_BASE}/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}`
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${cfg.apiToken}` },
  })
  if (!res.ok) throw new Error(`d1_get_http_${res.status}`)
  const json = (await res.json()) as { result?: { file_size?: number } }
  const size = json.result?.file_size
  if (typeof size !== 'number') throw new Error('d1_get_no_size')
  return size
}

async function postExport(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<ExportResult> {
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`export_http_${res.status}`)
  const json = (await res.json()) as { result?: ExportResult; success?: boolean }
  if (!json.result) throw new Error('export_no_result')
  return json.result
}
