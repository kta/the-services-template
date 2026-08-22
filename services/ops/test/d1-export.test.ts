import { describe, expect, it, vi } from 'vitest'
import { type D1ExportConfig, exportD1Dump, fetchD1FileSize } from '../src/d1-export'

const cfg: D1ExportConfig = { accountId: 'a', databaseId: 'd', apiToken: 't' }

// テストでは実待機しない(呼び出し回数・間隔だけ検証する)。
const instantSleep = () => Promise.resolve()

function fetchSeq(responses: Array<() => Response>): typeof fetch {
  let i = 0
  return (async () => {
    const make = responses[Math.min(i, responses.length - 1)]
    i += 1
    return make?.() ?? new Response('', { status: 500 })
  }) as unknown as typeof fetch
}

describe('exportD1Dump', () => {
  it('processing → complete で signed_url をダウンロードして本文を返す', async () => {
    const f = fetchSeq([
      () => new Response(JSON.stringify({ result: { status: 'processing', at_bookmark: 'b' } })),
      () =>
        new Response(
          JSON.stringify({ result: { status: 'complete', result: { signed_url: 'https://s/x' } } }),
        ),
      () => new Response('DUMP-BODY'),
    ])
    expect(await exportD1Dump(cfg, f, instantSleep)).toBe('DUMP-BODY')
  })

  it('processing の間はポーリング間隔を空ける(即時連打しない)', async () => {
    const sleep = vi.fn(() => Promise.resolve())
    const f = fetchSeq([
      () => new Response(JSON.stringify({ result: { status: 'processing', at_bookmark: 'b1' } })),
      () => new Response(JSON.stringify({ result: { status: 'processing', at_bookmark: 'b2' } })),
      () =>
        new Response(
          JSON.stringify({ result: { status: 'complete', result: { signed_url: 'https://s/x' } } }),
        ),
      () => new Response('DUMP-BODY'),
    ])
    expect(await exportD1Dump(cfg, f, sleep)).toBe('DUMP-BODY')
    // processing 応答 2 回 → 次の poll の前に毎回待機している
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(expect.any(Number))
  })

  it('MAX_POLLS 回 processing のままなら export_timeout', async () => {
    const forever = (async () =>
      new Response(
        JSON.stringify({ result: { status: 'processing', at_bookmark: 'b' } }),
      )) as unknown as typeof fetch
    await expect(exportD1Dump(cfg, forever, instantSleep)).rejects.toThrow(/export_timeout/)
  })

  it('export POST が非 2xx なら例外', async () => {
    const f = fetchSeq([() => new Response('nope', { status: 403 })])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_http_403/)
  })

  it('result が無ければ例外', async () => {
    const f = fetchSeq([() => new Response(JSON.stringify({ success: true }))])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_no_result/)
  })

  it('status が failed 等なら例外', async () => {
    const f = fetchSeq([
      () => new Response(JSON.stringify({ result: { status: 'processing', at_bookmark: 'b' } })),
      () => new Response(JSON.stringify({ result: { status: 'failed', error: 'boom' } })),
    ])
    await expect(exportD1Dump(cfg, f, instantSleep)).rejects.toThrow(/export_failed:boom/)
  })

  it('status が failed で API エラー詳細が無ければ status を失敗理由にする', async () => {
    const f = fetchSeq([() => new Response(JSON.stringify({ result: { status: 'failed' } }))])
    await expect(exportD1Dump(cfg, f, instantSleep)).rejects.toThrow('export_failed:failed')
  })

  it('complete でも signed_url 欠落なら例外', async () => {
    const f = fetchSeq([
      () => new Response(JSON.stringify({ result: { status: 'complete', result: {} } })),
    ])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_no_url/)
  })

  it('signed_url のダウンロードが失敗なら例外', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({ result: { status: 'complete', result: { signed_url: 'https://s/x' } } }),
        ),
      () => new Response('err', { status: 500 }),
    ])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_download_500/)
  })
})

describe('fetchD1FileSize', () => {
  it('file_size が欠落した REST 応答は容量判定に使わず失敗として返す', async () => {
    const f = (async () => new Response(JSON.stringify({ result: {} }))) as unknown as typeof fetch
    await expect(fetchD1FileSize(cfg, f)).rejects.toThrow('d1_get_no_size')
  })
})
