import { env, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'

const BASE = 'https://notifier.test'
const INTERNAL = { 'content-type': 'application/json', 'x-internal-key': 'dev-internal-key' }

const job = (over: Record<string, unknown> = {}) => ({
  id: 'user.invited:r1',
  type: 'user.invited',
  to: 'staff@example.com',
  payload: { acceptUrl: 'https://app.test/invite?token=t' },
  ...over,
})

function send(body: unknown, headers: Record<string, string> = INTERNAL) {
  return SELF.fetch(`${BASE}/api/internal/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

afterEach(() => vi.restoreAllMocks())

describe('notifier sync send API (sync send, no queue)', () => {
  it('GET /api/health は 200', async () => {
    const res = await SELF.fetch(`${BASE}/api/health`)
    expect(res.status).toBe(200)
  })

  it('x-internal-key 無しは 401', async () => {
    const res = await send(job(), { 'content-type': 'application/json' })
    expect(res.status).toBe(401)
  })

  it('有効なジョブを送信し dedupe を記録(LogSender)', async () => {
    const res = await send(job({ id: 'user.invited:ok' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'sent' })
    expect(await env.DEDUPE.get('user.invited:ok')).toBe('1')
  })

  it('冪等: 既送信 id は duplicate で二重送信しない', async () => {
    await env.DEDUPE.put('user.invited:dup', '1')
    const res = await send(job({ id: 'user.invited:dup' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'duplicate' })
  })

  it('不正なジョブは 400', async () => {
    const res = await send({ not: 'a job' })
    expect(res.status).toBe(400)
  })

  it('dedupe 読み取り失敗は at-least-once に倒して送信する(500 にしない)', async () => {
    vi.spyOn(env.DEDUPE, 'get').mockRejectedValue(new Error('kv read failed') as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(job({ id: 'user.invited:kvread' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'sent' })
  })

  it('RESEND_API_KEY も MAIL_DEV_LOG も無い環境は 502(送信成功を偽装しない)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request(
      '/api/internal/send',
      { method: 'POST', headers: INTERNAL, body: JSON.stringify(job({ id: 'user.invited:nos' })) },
      {
        DEDUPE: env.DEDUPE,
        RESEND_API_KEY: '',
        MAIL_DEV_LOG: '',
        INTERNAL_KEY: 'dev-internal-key',
      },
    )
    expect(res.status).toBe(502)
    // 未送信なので dedupe も残らない(設定後の再送で届く)
    expect(await env.DEDUPE.get('user.invited:nos')).toBeNull()
  })

  it('送信成功後の dedupe 書き込み失敗は sent を返す(502 だと呼び出し側が再送して二重送信)', async () => {
    vi.spyOn(env.DEDUPE, 'put').mockRejectedValue(new Error('kv quota exceeded') as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(job({ id: 'user.invited:kvfail' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'sent' })
  })

  it('送信失敗(Resend 非2xx)は 502、dedupe を残さない', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response('err', { status: 500 }))) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // RESEND_API_KEY を持つ env を app.request で注入し ResendSender を踏ませる。
    const res = await app.request(
      '/api/internal/send',
      { method: 'POST', headers: INTERNAL, body: JSON.stringify(job({ id: 'user.invited:502' })) },
      { DEDUPE: env.DEDUPE, RESEND_API_KEY: 'test-key', INTERNAL_KEY: 'dev-internal-key' },
    )
    expect(res.status).toBe(502)
    expect(await env.DEDUPE.get('user.invited:502')).toBeNull()
  })
})
