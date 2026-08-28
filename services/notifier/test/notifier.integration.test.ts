import { env, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'

const BASE = 'https://notifier.test'
const INTERNAL = {
  'content-type': 'application/json',
  'x-internal-key': 'dev-admin-to-notifier-key-000000000000',
  'x-internal-caller': 'admin',
}

const job = (over: Record<string, unknown> = {}) => ({
  id: 'user.invited:r1',
  type: 'user.invited',
  to: 'staff@example.com',
  payload: { acceptUrl: 'https://app.test/invite#token=t' },
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

  it('別の service-binding 方向の鍵は 401', async () => {
    for (const key of ['dev-admin-to-domain-key', 'dev-domain-to-admin-key']) {
      const res = await send(job({ id: `user.invited:wrong-key:${key}` }), {
        ...INTERNAL,
        'x-internal-key': key,
      })
      expect(res.status).toBe(401)
    }
  })

  it('caller key が同一に設定された環境は fail close(503)', async () => {
    const res = await app.request(
      '/api/internal/send',
      { method: 'POST', headers: INTERNAL, body: JSON.stringify(job({ id: 'same-keys' })) },
      {
        DEDUPE: env.DEDUPE,
        RESEND_API_KEY: '',
        MAIL_DEV_LOG: 'true',
        APP_ENV: 'development',
        ADMIN_TO_NOTIFIER_KEY: 'same-key-0000000000000000000000000000',
        DOMAIN_TO_NOTIFIER_KEY: 'same-key-0000000000000000000000000000',
        OPS_TO_NOTIFIER_KEY: 'same-key-0000000000000000000000000000',
      },
    )
    expect(res.status).toBe(503)
  })

  it('domain caller は登録済みの宛先以外へ送れない', async () => {
    const res = await send(
      {
        id: 'domain-arbitrary-recipient',
        type: 'item.created',
        to: 'attacker@example.com',
        payload: { itemId: 'i1', title: 'T' },
      },
      {
        'content-type': 'application/json',
        'x-internal-key': 'dev-domain-to-notifier-key-000000000000',
        'x-internal-caller': 'domain',
      },
    )
    expect(res.status).toBe(403)
  })

  it('招待 URL は設定済み admin origin 以外へ転送できない', async () => {
    const res = await send(
      job({
        id: 'invite-arbitrary-origin',
        payload: { acceptUrl: 'https://evil.example/invite#token=t' },
      }),
    )
    expect(res.status).toBe(403)
  })

  it('内部送信 body の上限を超える要求は 413', async () => {
    const res = await send(job({ id: 'oversized-job', payload: { value: 'x'.repeat(40_000) } }))
    expect(res.status).toBe(413)
  })

  it('caller ごとの通知 type 権限を越境できない', async () => {
    const domainOps = await send(job({ id: 'domain-ops', type: 'ops.sync_drift' }), {
      'content-type': 'application/json',
      'x-internal-key': 'dev-domain-to-notifier-key-000000000000',
      'x-internal-caller': 'domain',
    })
    expect(domainOps.status).toBe(403)

    const opsItem = await send(job({ id: 'ops-item', type: 'item.created' }), {
      'content-type': 'application/json',
      'x-internal-key': 'dev-ops-to-notifier-key-000000000000',
      'x-internal-caller': 'ops',
    })
    expect(opsItem.status).toBe(403)
  })

  it('caller ごとの許可された全通知型を受け付ける', async () => {
    const cases = [
      {
        caller: 'admin',
        key: 'dev-admin-to-notifier-key-000000000000',
        type: 'user.invited',
        to: 'staff@example.com',
        payload: { acceptUrl: 'https://app.test/invite#token=t' },
      },
      {
        caller: 'domain',
        key: 'dev-domain-to-notifier-key-000000000000',
        type: 'item.created',
        to: 'team@example.com',
        payload: { itemId: 'item-1', title: 'Item' },
      },
      {
        caller: 'ops',
        key: 'dev-ops-to-notifier-key-000000000000',
        type: 'ops.backup_failed',
        to: 'ops@example.com',
        payload: { failed: [{ target: 'admin', reason: 'export_timeout' }] },
      },
      {
        caller: 'ops',
        key: 'dev-ops-to-notifier-key-000000000000',
        type: 'ops.backup_stale',
        to: 'ops@example.com',
        payload: { latest: '2026-07-12T00:00:00Z', staleTargets: ['admin'] },
      },
      {
        caller: 'ops',
        key: 'dev-ops-to-notifier-key-000000000000',
        type: 'ops.health_check_failed',
        to: 'ops@example.com',
        payload: { down: ['admin'] },
      },
      {
        caller: 'ops',
        key: 'dev-ops-to-notifier-key-000000000000',
        type: 'ops.monitor_failed',
        to: 'ops@example.com',
        payload: { component: 'capacity', failed: [{ target: 'admin', reason: 'request_failed' }] },
      },
      {
        caller: 'admin',
        key: 'dev-admin-to-notifier-key-000000000000',
        type: 'ops.sync_drift',
        to: 'ops@example.com',
        payload: { organizationIds: ['org-1'], count: 1, failed: [], truncated: false },
      },
      {
        caller: 'ops',
        key: 'dev-ops-to-notifier-key-000000000000',
        type: 'ops.capacity_warning',
        to: 'ops@example.com',
        payload: {
          over: [{ target: 'admin', bytes: 419_430_400, mb: 400 }],
          thresholdMb: 400,
        },
      },
    ] as const

    for (const item of cases) {
      const res = await send(
        {
          id: `valid-${item.type}-${crypto.randomUUID()}`,
          type: item.type,
          to: item.to,
          payload: item.payload,
        },
        {
          'content-type': 'application/json',
          'x-internal-key': item.key,
          'x-internal-caller': item.caller,
        },
      )
      expect(res.status, item.type).toBe(200)
    }
  })

  it('有効なジョブを送信し dedupe を記録(LogSender)', async () => {
    const res = await send(job({ id: 'user.invited:ok' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'sent' })
    expect(await env.DEDUPE.get('admin:user.invited:ok')).toBe('1')
  })

  it('Resend には caller/job の固定長ハッシュだけを渡す', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    const longId = `user.invited:${'x'.repeat(240)}`
    const response = await app.request(
      '/api/internal/send',
      { method: 'POST', headers: INTERNAL, body: JSON.stringify(job({ id: longId })) },
      {
        DEDUPE: env.DEDUPE,
        RESEND_API_KEY: 'test-key',
        APP_ENV: 'production',
        INVITE_BASE_URL: 'https://app.test',
        ADMIN_TO_NOTIFIER_KEY: INTERNAL['x-internal-key'],
        DOMAIN_TO_NOTIFIER_KEY: 'dev-domain-to-notifier-key-000000000000',
        OPS_TO_NOTIFIER_KEY: 'dev-ops-to-notifier-key-000000000000',
      },
    )

    expect(response.status).toBe(200)
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const providerKey = (init.headers as Record<string, string>)['idempotency-key']
    if (typeof providerKey !== 'string') throw new Error('missing Resend idempotency key')
    expect(providerKey).toMatch(/^v1-[0-9a-f]{64}$/)
    expect(providerKey.length).toBe(67)
    expect(providerKey).not.toContain(longId)
    expect(await env.DEDUPE.get(`admin:${longId}`)).toBe('1')
  })

  it('development は HTTP 招待リンクを受け付けるが production は拒否する', async () => {
    const request = (appEnv: string, id: string) =>
      app.request(
        '/api/internal/send',
        {
          method: 'POST',
          headers: INTERNAL,
          body: JSON.stringify(
            job({
              id,
              payload: { acceptUrl: 'http://localhost:5174/invite#token=t' },
            }),
          ),
        },
        {
          DEDUPE: env.DEDUPE,
          RESEND_API_KEY: '',
          MAIL_DEV_LOG: 'true',
          INVITE_BASE_URL: 'http://localhost:5174',
          APP_ENV: appEnv,
          ADMIN_TO_NOTIFIER_KEY: 'dev-admin-to-notifier-key-000000000000',
          DOMAIN_TO_NOTIFIER_KEY: 'dev-domain-to-notifier-key-000000000000',
          OPS_TO_NOTIFIER_KEY: 'dev-ops-to-notifier-key-000000000000',
        },
      )

    expect((await request('development', 'user.invited:http-dev')).status).toBe(200)
    expect((await request('production', 'user.invited:http-prod')).status).toBe(403)
  })

  it('冪等: 既送信 id は duplicate で二重送信しない', async () => {
    await env.DEDUPE.put('admin:user.invited:dup', '1')
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
        APP_ENV: 'production',
        INVITE_BASE_URL: 'https://app.test',
        ADMIN_TO_NOTIFIER_KEY: 'dev-admin-to-notifier-key-000000000000',
        DOMAIN_TO_NOTIFIER_KEY: 'dev-domain-to-notifier-key-000000000000',
        OPS_TO_NOTIFIER_KEY: 'dev-ops-to-notifier-key-000000000000',
      },
    )
    expect(res.status).toBe(502)
    // 未送信なので dedupe も残らない(設定後の再送で届く)
    expect(await env.DEDUPE.get('admin:user.invited:nos')).toBeNull()
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
      {
        DEDUPE: env.DEDUPE,
        RESEND_API_KEY: 'test-key',
        APP_ENV: 'production',
        INVITE_BASE_URL: 'https://app.test',
        ADMIN_TO_NOTIFIER_KEY: 'dev-admin-to-notifier-key-000000000000',
        DOMAIN_TO_NOTIFIER_KEY: 'dev-domain-to-notifier-key-000000000000',
        OPS_TO_NOTIFIER_KEY: 'dev-ops-to-notifier-key-000000000000',
      },
    )
    expect(res.status).toBe(502)
    expect(await env.DEDUPE.get('admin:user.invited:502')).toBeNull()
  })
})
