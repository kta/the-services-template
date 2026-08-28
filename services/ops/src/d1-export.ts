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

export type D1DumpStream = {
  stream: ReadableStream<Uint8Array>
  contentLength: number
}

type ExportResult = {
  at_bookmark?: string
  status?: 'processing' | 'complete' | string
  result?: { signed_url?: string; filename?: string }
  error?: string
}

const API_BASE = 'https://api.cloudflare.com/client/v4'
// Keep the entire export (polling + signed download) below the Workflow
// backup step's 10-minute timeout. A longer unbounded poll only causes a
// durable step retry to overlap a still-running D1 export.
const MAX_POLLS = 16
// D1 Free の 500MB/DB 上限に SQL export の余白を加えた fail-closed ceiling。
// 本番 backup は `exportD1DumpStream` を使い、本文全体を Worker memory に載せない。
const MAX_D1_EXPORT_BYTES = 512 * 1024 * 1024
// polling は間隔を空ける。大きな DB は export 中に D1 をブロックするため、
// 16 回 × (15s request timeout + 2s interval) is about 4.5 minutes worst case.
const POLL_INTERVAL_MS = 2_000
const CONTROL_REQUEST_TIMEOUT_MS = 15_000
// signed_url の本文は最大 512MiB なので、control-plane の 15 秒 timeout を
// 全本文の転送に使うと正常な低速回線を誤って切断する。Workflow step の 10 分以内で
// polling の余白も残すため 4 分で打ち切り、無期限待機にはしない。
const SIGNED_DOWNLOAD_TIMEOUT_MS = 4 * 60 * 1_000

function externalRequestSignal(timeoutMs = CONTROL_REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

type SleepImpl = (ms: number) => Promise<void>
const defaultSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** export を開始し complete まで polling → signed_url から SQL 本文を返す。 */
export async function exportD1Dump(
  cfg: D1ExportConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: SleepImpl = defaultSleep,
  maxBytes = MAX_D1_EXPORT_BYTES,
): Promise<string> {
  const dumpRes = await exportD1Response(cfg, fetchImpl, sleepImpl)
  return readResponseTextWithinLimit(dumpRes, maxBytes)
}

/**
 * 本番 backup 用。signed URL の本文を全量文字列化せず、呼び出し側が R2 upload と
 * validation に tee できるよう response body を返す。
 */
export async function exportD1DumpStream(
  cfg: D1ExportConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: SleepImpl = defaultSleep,
  maxBytes = MAX_D1_EXPORT_BYTES,
): Promise<D1DumpStream> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('export_download_limit_invalid')
  }
  const dumpRes = await exportD1Response(cfg, fetchImpl, sleepImpl)
  if (!dumpRes.body) throw new Error('export_download_empty')
  const contentLength = dumpRes.headers.get('content-length')
  if (
    !contentLength ||
    !/^\d+$/.test(contentLength) ||
    !Number.isSafeInteger(Number(contentLength))
  ) {
    throw new Error('export_download_length_unknown')
  }
  const contentLengthBytes = Number(contentLength)
  if (contentLengthBytes > maxBytes) throw new Error('export_download_too_large')
  return {
    // The outer FixedLengthStream is added by the R2 upload caller. Returning
    // the advertised length alongside the bounded stream lets that caller
    // satisfy R2's known-length requirement without buffering the dump.
    stream: limitResponseBody(dumpRes.body, maxBytes, contentLengthBytes),
    contentLength: contentLengthBytes,
  }
}

/**
 * Content-Length is advisory. Enforce the ceiling while consuming the real
 * body as well, canceling the upstream reader as soon as a lying/changed
 * response crosses the bound.
 */
function limitResponseBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedLength?: number,
) {
  const reader = body.getReader()
  let bytes = 0
  let finished = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          if (expectedLength !== undefined && bytes !== expectedLength) {
            finished = true
            reader.releaseLock()
            controller.error(new Error('export_download_length_mismatch'))
            return
          }
          finished = true
          reader.releaseLock()
          controller.close()
          return
        }
        if (!value) return
        bytes += value.byteLength
        if (bytes > maxBytes) {
          await reader.cancel('export_download_too_large')
          finished = true
          reader.releaseLock()
          controller.error(new Error('export_download_too_large'))
          return
        }
        controller.enqueue(value)
      } catch (error) {
        if (!finished) {
          finished = true
          reader.releaseLock()
        }
        controller.error(error)
      }
    },
    async cancel(reason) {
      if (!finished) {
        finished = true
        await reader.cancel(reason)
        reader.releaseLock()
      }
    },
  })
}

async function exportD1Response(
  cfg: D1ExportConfig,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImpl,
): Promise<Response> {
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
    if (state.status && state.status !== 'processing') throw new Error('export_failed')
    if (typeof state.at_bookmark !== 'string' || state.at_bookmark.trim() === '') {
      throw new Error('export_no_bookmark')
    }
    await sleepImpl(POLL_INTERVAL_MS)
    state = await postExport(fetchImpl, url, headers, {
      output_format: 'polling',
      current_bookmark: state.at_bookmark,
    })
  }

  const signed = state.result?.signed_url
  if (!signed) throw new Error('export_no_url')
  const signedUrl = new URL(signed)
  if (
    signedUrl.protocol !== 'https:' ||
    signedUrl.username ||
    signedUrl.password ||
    signedUrl.port ||
    signedUrl.hash ||
    !isCloudflareOwnedHost(signedUrl.hostname)
  ) {
    throw new Error('export_url_invalid')
  }
  const dumpRes = await fetchImpl(signedUrl, {
    redirect: 'error',
    signal: externalRequestSignal(SIGNED_DOWNLOAD_TIMEOUT_MS),
  })
  if (!dumpRes.ok) throw new Error(`export_download_${dumpRes.status}`)
  return dumpRes
}

async function readResponseTextWithinLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length')
  const expectedLength =
    contentLength && /^\d+$/.test(contentLength) && Number.isSafeInteger(Number(contentLength))
      ? Number(contentLength)
      : undefined
  if (expectedLength !== undefined && expectedLength > maxBytes) {
    throw new Error('export_download_too_large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let cancelReason: string | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maxBytes) {
        cancelReason = 'export_download_too_large'
        throw new Error(cancelReason)
      }
      chunks.push(value)
    }
  } finally {
    if (cancelReason) {
      try {
        await reader.cancel(cancelReason)
      } catch {
        // The body is already over the bound. Preserve the deterministic
        // limit error even when the upstream stream rejects cancellation.
      }
    }
    reader.releaseLock()
  }
  if (expectedLength !== undefined && bytes !== expectedLength) {
    throw new Error('export_download_length_mismatch')
  }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)
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
    redirect: 'error',
    signal: externalRequestSignal(),
  })
  if (!res.ok) throw new Error(`d1_get_http_${res.status}`)
  const json = (await res.json()) as { success?: boolean; result?: { file_size?: number } }
  if (json.success !== true) throw new Error('d1_get_api_unsuccessful')
  const size = json.result?.file_size
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_D1_EXPORT_BYTES
  ) {
    throw new Error('d1_get_invalid_size')
  }
  return size
}

function isCloudflareOwnedHost(hostname: string): boolean {
  return (
    hostname === 'api.cloudflare.com' ||
    hostname === 'cloudflarestorage.com' ||
    hostname.endsWith('.cloudflarestorage.com')
  )
}

async function postExport(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<ExportResult> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: externalRequestSignal(),
  })
  if (!res.ok) throw new Error(`export_http_${res.status}`)
  const json = (await res.json()) as { result?: ExportResult; success?: boolean }
  if (json.success !== true) throw new Error('export_api_unsuccessful')
  if (!json.result) throw new Error('export_no_result')
  return json.result
}
