import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { internalAuth, sendNotification } from '../src/internal'

const KEY = 'secret-internal-key'

function makeApp() {
  const app = new Hono<{ Bindings: { INTERNAL_KEY: string } }>()
  app.use('/api/internal/*', internalAuth())
  app.get('/api/internal/x', (c) => c.json({ ok: true }))
  return app
}

describe('internalAuth', () => {
  it('正しい x-internal-key で通す', async () => {
    const res = await makeApp().request(
      '/api/internal/x',
      { headers: { 'x-internal-key': KEY } },
      { INTERNAL_KEY: KEY },
    )
    expect(res.status).toBe(200)
  })

  it('ヘッダ無し / 不一致 / 長さ違いは 401', async () => {
    const app = makeApp()
    const none = await app.request('/api/internal/x', {}, { INTERNAL_KEY: KEY })
    expect(none.status).toBe(401)
    const wrong = await app.request(
      '/api/internal/x',
      { headers: { 'x-internal-key': 'secret-internal-kex' } },
      { INTERNAL_KEY: KEY },
    )
    expect(wrong.status).toBe(401)
    const short = await app.request(
      '/api/internal/x',
      { headers: { 'x-internal-key': 'k' } },
      { INTERNAL_KEY: KEY },
    )
    expect(short.status).toBe(401)
  })

  it('fail close: secret 未設定なら正解相当のヘッダでも全拒否', async () => {
    // 未設定 env と欠落ヘッダが undefined 同士で一致して素通りする事故の回帰テスト
    const res = await makeApp().request(
      '/api/internal/x',
      { headers: { 'x-internal-key': '' } },
      { INTERNAL_KEY: '' },
    )
    expect(res.status).toBe(401)
  })
})

describe('sendNotification', () => {
  const job = { id: 'j1', type: 'item.created' as const, to: 'a@b.test', payload: {} }

  it('2xx で true、x-internal-key とタイムアウト signal を付けて POST する', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    const ok = await sendNotification({ fetch: fetchSpy }, KEY, job)
    expect(ok).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; signal?: unknown },
    ]
    expect(url).toContain('/api/internal/send')
    expect(init.headers['x-internal-key']).toBe(KEY)
    // ハングした notifier が呼び出し側の本処理を無期限に道連れにしないための signal
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('非 2xx は false(throw しない — best-effort 規約)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = await sendNotification({ fetch: async () => ({ ok: false, status: 502 }) }, KEY, job)
    expect(ok).toBe(false)
  })

  it('fetch が throw しても false(呼び出し側の本処理を止めない)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = await sendNotification(
      {
        fetch: async () => {
          throw new Error('binding down')
        },
      },
      KEY,
      job,
    )
    expect(ok).toBe(false)
  })
})
