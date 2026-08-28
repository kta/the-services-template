import { describe, expect, it, vi } from 'vitest'
import {
  type D1ExportConfig,
  exportD1Dump,
  exportD1DumpStream,
  fetchD1FileSize,
} from '../src/d1-export'

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
      () =>
        new Response(
          JSON.stringify({ success: true, result: { status: 'processing', at_bookmark: 'b' } }),
        ),
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () => new Response('DUMP-BODY'),
    ])
    expect(await exportD1Dump(cfg, f, instantSleep)).toBe('DUMP-BODY')
  })

  it('processing の間はポーリング間隔を空ける(即時連打しない)', async () => {
    const sleep = vi.fn(() => Promise.resolve())
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({ success: true, result: { status: 'processing', at_bookmark: 'b1' } }),
        ),
      () =>
        new Response(
          JSON.stringify({ success: true, result: { status: 'processing', at_bookmark: 'b2' } }),
        ),
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
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
        JSON.stringify({ success: true, result: { status: 'processing', at_bookmark: 'b' } }),
      )) as unknown as typeof fetch
    await expect(exportD1Dump(cfg, forever, instantSleep)).rejects.toThrow(/export_timeout/)
  })

  it('export POST が非 2xx なら例外', async () => {
    const f = fetchSeq([() => new Response('nope', { status: 403 })])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_http_403/)
  })

  it('HTTP 200 でも Cloudflare success=false なら例外', async () => {
    const f = fetchSeq([
      () => new Response(JSON.stringify({ success: false, errors: [{ message: 'denied' }] })),
    ])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_api_unsuccessful/)
  })

  it('result が無ければ例外', async () => {
    const f = fetchSeq([() => new Response(JSON.stringify({ success: true }))])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_no_result/)
  })

  it('status が failed 等なら例外', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({ success: true, result: { status: 'processing', at_bookmark: 'b' } }),
        ),
      () =>
        new Response(
          JSON.stringify({ success: true, result: { status: 'failed', error: 'boom' } }),
        ),
    ])
    await expect(exportD1Dump(cfg, f, instantSleep)).rejects.toThrow('export_failed')
    const error = await exportD1Dump(
      cfg,
      fetchSeq([
        () =>
          new Response(
            JSON.stringify({ success: true, result: { status: 'processing', at_bookmark: 'b' } }),
          ),
        () =>
          new Response(
            JSON.stringify({ success: true, result: { status: 'failed', error: 'boom' } }),
          ),
      ]),
      instantSleep,
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('boom')
  })

  it('processing 応答に bookmark が無ければ fail close する', async () => {
    const f = fetchSeq([
      () => new Response(JSON.stringify({ success: true, result: { status: 'processing' } })),
    ])
    await expect(exportD1Dump(cfg, f, instantSleep)).rejects.toThrow(/export_no_bookmark/)
  })

  it('status が failed で API エラー詳細が無ければ status を失敗理由にする', async () => {
    const f = fetchSeq([
      () => new Response(JSON.stringify({ success: true, result: { status: 'failed' } })),
    ])
    await expect(exportD1Dump(cfg, f, instantSleep)).rejects.toThrow('export_failed')
  })

  it('complete でも signed_url 欠落なら例外', async () => {
    const f = fetchSeq([
      () =>
        new Response(JSON.stringify({ success: true, result: { status: 'complete', result: {} } })),
    ])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_no_url/)
  })

  it('signed_url のダウンロードが失敗なら例外', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () => new Response('err', { status: 500 }),
    ])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_download_500/)
  })

  it('signed_url の content-length が上限を超える場合は本文を読まずに拒否する', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () => new Response(null, { headers: { 'content-length': String(600 * 1024 * 1024) } }),
    ])
    await expect(exportD1Dump(cfg, f)).rejects.toThrow(/export_download_too_large/)
  })

  it('signed_url の content-length が妥当ならストリーム API は本文を返す', async () => {
    const body = 'CREATE TABLE users (id);'
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () =>
        new Response(body, {
          headers: { 'content-length': String(new TextEncoder().encode(body).byteLength) },
        }),
    ])
    const dump = await exportD1DumpStream(cfg, f, instantSleep)
    expect(dump.contentLength).toBe(new TextEncoder().encode(body).byteLength)
    await expect(new Response(dump.stream).text()).resolves.toBe(body)
  })

  it('signed_url の body が無い場合はストリーム API を fail close する', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () => new Response(null),
    ])
    await expect(exportD1DumpStream(cfg, f, instantSleep)).rejects.toThrow(/export_download_empty/)
  })

  it('content-length が無いストリームは R2 upload 前に fail close する', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () => new Response('DUMP-BODY'),
    ])
    await expect(exportD1DumpStream(cfg, f, instantSleep)).rejects.toThrow(
      /export_download_length_unknown/,
    )
  })

  it('content-length が小さくても実体が上限を超えたストリームを fail close する', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(513))
            },
          }),
          { headers: { 'content-length': '1' } },
        ),
    ])
    const dump = await exportD1DumpStream(cfg, f, instantSleep, 512)
    await expect(new Response(dump.stream).arrayBuffer()).rejects.toThrow(
      /export_download_too_large/,
    )
  })

  it('content-length より短いストリームを fail close する', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () => new Response('short', { headers: { 'content-length': '10' } }),
    ])
    const dump = await exportD1DumpStream(cfg, f, instantSleep)
    await expect(new Response(dump.stream).arrayBuffer()).rejects.toThrow(
      /export_download_length_mismatch/,
    )
  })

  it('全量文字列化する経路も上限超過時に上流ストリームを cancel する', async () => {
    let cancelReason: unknown
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () =>
        ({
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(513))
            },
            cancel(reason) {
              cancelReason = reason
            },
          }),
          headers: new Headers({ 'content-length': '1' }),
        }) as unknown as Response,
    ])

    await expect(exportD1Dump(cfg, f, instantSleep, 512)).rejects.toThrow(
      /export_download_too_large/,
    )
    expect(cancelReason).toBe('export_download_too_large')
  })

  it('Cloudflare REST と signed URL の各リクエストに timeout signal を付ける', async () => {
    const calls: RequestInit[] = []
    let count = 0
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      count += 1
      if (count === 1) {
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        )
      }
      return new Response('DUMP-BODY')
    }) as unknown as typeof fetch

    await expect(exportD1Dump(cfg, f, instantSleep)).resolves.toBe('DUMP-BODY')
    expect(calls).toHaveLength(2)
    expect(calls.every((init) => init.signal instanceof AbortSignal)).toBe(true)
    expect(calls[1]?.redirect).toBe('error')
  })

  it('signed_url は HTTPS かつ認証情報無しに限定する', async () => {
    for (const signedUrl of [
      'http://s/x',
      'https://user:password@s/x',
      'https://attacker.example/export.sql',
      'https://evil.cloudflare.com/export.sql',
    ]) {
      const f = fetchSeq([
        () =>
          new Response(
            JSON.stringify({
              success: true,
              result: { status: 'complete', result: { signed_url: signedUrl } },
            }),
          ),
      ])
      await expect(exportD1Dump(cfg, f, instantSleep)).rejects.toThrow(/export_url_invalid/)
    }
  })

  it('ストリーム API は signed_url の body をそのまま返す', async () => {
    const f = fetchSeq([
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              status: 'complete',
              result: { signed_url: 'https://api.cloudflare.com/s/x' },
            },
          }),
        ),
      () =>
        new Response('CREATE TABLE users (id);', {
          headers: { 'content-length': String('CREATE TABLE users (id);'.length) },
        }),
    ])
    const dump = await exportD1DumpStream(cfg, f, instantSleep)
    await expect(new Response(dump.stream).text()).resolves.toBe('CREATE TABLE users (id);')
  })
})

describe('fetchD1FileSize', () => {
  it('REST の非 2xx 応答は容量判定に使わず失敗として返す', async () => {
    const f = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    await expect(fetchD1FileSize(cfg, f)).rejects.toThrow('d1_get_http_403')
  })

  it('file_size が欠落した REST 応答は容量判定に使わず失敗として返す', async () => {
    const f = (async () =>
      new Response(JSON.stringify({ success: true, result: {} }))) as unknown as typeof fetch
    await expect(fetchD1FileSize(cfg, f)).rejects.toThrow('d1_get_invalid_size')
  })

  it('HTTP 200 でも Cloudflare success=false なら容量判定に使わない', async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({ success: false, result: { file_size: 1 } }),
      )) as unknown as typeof fetch
    await expect(fetchD1FileSize(cfg, f)).rejects.toThrow('d1_get_api_unsuccessful')
  })
})
