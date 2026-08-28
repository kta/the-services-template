import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { internalAuth, sendNotification } from '../src/internal'

const KEY = 'secret-internal-key-000000000000000000000000'
type InternalTestEnv = { Bindings: { DOMAIN_TO_ADMIN_KEY: string } }

function makeApp() {
  const app = new Hono<InternalTestEnv>()
  app.use('/api/internal/*', internalAuth<InternalTestEnv>('DOMAIN_TO_ADMIN_KEY'))
  app.get('/api/internal/x', (c) => c.json({ ok: true }))
  return app
}

describe('internalAuth', () => {
  it('正しい x-internal-key で通す', async () => {
    const res = await makeApp().request(
      '/api/internal/x',
      { headers: { 'x-internal-key': KEY } },
      { DOMAIN_TO_ADMIN_KEY: KEY },
    )
    expect(res.status).toBe(200)
  })

  it('ヘッダ無し / 不一致 / 長さ違いは 401', async () => {
    const app = makeApp()
    const none = await app.request('/api/internal/x', {}, { DOMAIN_TO_ADMIN_KEY: KEY })
    expect(none.status).toBe(401)
    const wrong = await app.request(
      '/api/internal/x',
      { headers: { 'x-internal-key': 'secret-internal-kex' } },
      { DOMAIN_TO_ADMIN_KEY: KEY },
    )
    expect(wrong.status).toBe(401)
    const short = await app.request(
      '/api/internal/x',
      { headers: { 'x-internal-key': 'k' } },
      { DOMAIN_TO_ADMIN_KEY: KEY },
    )
    expect(short.status).toBe(401)
  })

  it('fail close: secret 未設定なら正解相当のヘッダでも全拒否', async () => {
    // 未設定 env と欠落ヘッダが undefined 同士で一致して素通りする事故の回帰テスト
    const res = await makeApp().request(
      '/api/internal/x',
      { headers: { 'x-internal-key': '' } },
      { DOMAIN_TO_ADMIN_KEY: '' },
    )
    expect(res.status).toBe(401)
  })

  it('accepts any explicitly configured caller key without sharing one global key', async () => {
    type MultiKeyEnv = {
      Bindings: { ADMIN_TO_NOTIFIER_KEY: string; DOMAIN_TO_NOTIFIER_KEY: string }
    }
    const app = new Hono<MultiKeyEnv>()
    app.use(
      '/api/internal/*',
      internalAuth<MultiKeyEnv>(['ADMIN_TO_NOTIFIER_KEY', 'DOMAIN_TO_NOTIFIER_KEY']),
    )
    app.get('/api/internal/x', (c) => c.json({ ok: true }))

    expect(
      (
        await app.request(
          '/api/internal/x',
          { headers: { 'x-internal-key': 'admin-key-000000000000000000000000' } },
          {
            ADMIN_TO_NOTIFIER_KEY: 'admin-key-000000000000000000000000',
            DOMAIN_TO_NOTIFIER_KEY: 'domain-key-000000000000000000000000',
          },
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(
          '/api/internal/x',
          { headers: { 'x-internal-key': 'global-key' } },
          {
            ADMIN_TO_NOTIFIER_KEY: 'admin-key-000000000000000000000000',
            DOMAIN_TO_NOTIFIER_KEY: 'domain-key-000000000000000000000000',
          },
        )
      ).status,
    ).toBe(401)
  })
})

describe('sendNotification', () => {
  const job = { id: 'j1', type: 'item.created' as const, to: 'a@b.test', payload: {} }

  it('2xx で true、x-internal-key とタイムアウト signal を付けて POST する', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }))
    const ok = await sendNotification({ fetch: fetchSpy }, KEY, 'admin', job)
    expect(ok).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; signal?: unknown },
    ]
    expect(url).toContain('/api/internal/send')
    expect(init.headers['x-internal-key']).toBe(KEY)
    expect(init.headers['x-internal-caller']).toBe('admin')
    // ハングした notifier が呼び出し側の本処理を無期限に道連れにしないための signal
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('非 2xx は false(throw しない — best-effort 規約)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = await sendNotification(
      { fetch: async () => ({ ok: false, status: 502 }) },
      KEY,
      'admin',
      job,
    )
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
      'admin',
      job,
    )
    expect(ok).toBe(false)
  })
})
