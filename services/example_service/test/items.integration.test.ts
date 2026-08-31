import { env, SELF } from 'cloudflare:test'
import { DOMAIN_ACCESS_TOKEN_AUDIENCE } from '@app/contracts'
import { signAccessToken } from '@app/shared'
import { sign as signJwt } from 'hono/jwt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JWT_TEST_PRIVATE_KEY } from '../../../packages/shared/test/jwt-keys'
import app, { type Bindings } from '../src/worker'

const BASE = 'https://example-service.test'
const INTERNAL = {
  'content-type': 'application/json',
  'x-internal-key': 'dev-admin-to-example-service-key-000000000000',
}
const TEST_PRIVATE_KEY =
  (env as typeof env & { AUTH_DEV_PRIVATE_KEY?: string }).AUTH_DEV_PRIVATE_KEY ||
  JWT_TEST_PRIVATE_KEY

afterEach(() => vi.restoreAllMocks())

// dev グラント経由(org 同期行も upsert される — dev の利便)。
async function authHeaders(org = 'org_test'): Promise<Record<string, string>> {
  const res = await SELF.fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId: org }),
  })
  if (!res.ok) throw new Error(`dev token grant failed: ${res.status} ${await res.text()}`)
  const { token } = (await res.json()) as { token: string }
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

// dev グラントを通さず直接署名(org 同期行を作らない — 未同期ケース用)。
async function rawToken(org: string): Promise<string> {
  return signAccessToken(
    { sub: `test:${org}`, org, email: 'test@example.com', role: 'staff' },
    TEST_PRIVATE_KEY,
    undefined,
    undefined,
    DOMAIN_ACCESS_TOKEN_AUDIENCE,
  )
}

async function upsertOrg(over: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/internal/organizations`, {
    method: 'POST',
    headers: INTERNAL,
    body: JSON.stringify({
      id: 'o-sync',
      name: 'Acme',
      plan: 'free',
      isDisabled: false,
      version: 1,
      profile: {},
      createdAt: new Date().toISOString(),
      ...over,
    }),
  })
}

describe('example_service API (integration, real D1 in workerd)', () => {
  it('GET /api/health returns ok', async () => {
    const res = await SELF.fetch(`${BASE}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('rejects /api/items without a JWT (401)', async () => {
    const res = await SELF.fetch(`${BASE}/api/items`)
    expect(res.status).toBe(401)
  })

  it('POST then GET /api/items persists to D1, scoped to the token org', async () => {
    const headers = await authHeaders()
    const created = await SELF.fetch(`${BASE}/api/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'integration item', body: 'hello' }),
    })
    expect(created.status).toBe(201)

    const list = await SELF.fetch(`${BASE}/api/items`, { headers })
    expect(list.status).toBe(200)
    const rows = (await list.json()) as Array<{ title: string }>
    expect(rows.some((r) => r.title === 'integration item')).toBe(true)
  })

  it('does not leak items across tenants', async () => {
    await SELF.fetch(`${BASE}/api/items`, {
      method: 'POST',
      headers: await authHeaders('org_a'),
      body: JSON.stringify({ title: 'org A only', body: '' }),
    })
    const list = await SELF.fetch(`${BASE}/api/items`, { headers: await authHeaders('org_b') })
    const rows = (await list.json()) as Array<{ title: string }>
    expect(rows.some((r) => r.title === 'org A only')).toBe(false)
  })

  it('POST /api/items rejects an empty title with 400', async () => {
    const res = await SELF.fetch(`${BASE}/api/items`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ title: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/items rejects an oversized JSON body before parsing', async () => {
    const res = await SELF.fetch(`${BASE}/api/items`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ title: 'bounded', body: 'x'.repeat(70_000) }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
  })

  it('notifies via the notifier binding on item creation', async () => {
    const sendSpy = vi
      .spyOn(env.NOTIFIER, 'fetch')
      .mockResolvedValue(new Response('{"status":"sent"}', { status: 200 }) as never)
    const res = await SELF.fetch(`${BASE}/api/items`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ title: 'notify me', body: '' }),
    })
    expect(res.status).toBe(201)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const [url, init] = sendSpy.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/api/internal/send')
    const job = JSON.parse(String(init.body)) as { id: string; type: string }
    expect(job.type).toBe('item.created')
    expect(job.id.startsWith('item.created:')).toBe(true)
  })

  it('notification is best-effort: create still succeeds when the notifier is down', async () => {
    vi.spyOn(env.NOTIFIER, 'fetch').mockRejectedValue(new Error('notifier unreachable') as never)
    const res = await SELF.fetch(`${BASE}/api/items`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ title: 'still created', body: '' }),
    })
    expect(res.status).toBe(201)
  })
})

describe('tenant auth middleware (tenantAuth + requireActiveOrg)', () => {
  it('production API checks the admin live session before the mirrored org row', async () => {
    const orgId = `org-live-${crypto.randomUUID()}`
    await upsertOrg({ id: orgId, name: 'Live session Co', isDisabled: false })
    const sessionId = `session-${crypto.randomUUID()}`
    const token = await signAccessToken(
      {
        sub: `user-${crypto.randomUUID()}`,
        org: orgId,
        email: 'live@example.com',
        role: 'staff',
        sid: sessionId,
      },
      TEST_PRIVATE_KEY,
      undefined,
      undefined,
      DOMAIN_ACCESS_TOKEN_AUDIENCE,
    )
    const adminFetch = vi.fn(async () => Response.json({ active: true, role: 'staff' }))
    const productionEnv = {
      ...env,
      APP_ENV: 'production',
      AUTH_DEV_GRANT: 'false',
      ADMIN: { fetch: adminFetch },
    } as unknown as Bindings

    const allowed = await app.request(
      `${BASE}/api/items`,
      { headers: { authorization: `Bearer ${token}` } },
      productionEnv,
    )
    expect(allowed.status).toBe(200)
    expect(adminFetch).toHaveBeenCalledWith(
      'http://admin/api/internal/auth/session',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-internal-caller': 'domain',
          'x-internal-key': 'dev-domain-to-admin-key-000000000000',
        }),
      }),
    )
    const adminCall = adminFetch.mock.calls[0] as unknown as [string, RequestInit] | undefined
    const adminRequest = adminCall?.[1]
    expect(JSON.parse(String(adminRequest?.body))).toEqual({
      sid: sessionId,
      sub: expect.any(String),
      org: orgId,
    })

    adminFetch.mockResolvedValue(Response.json({ active: false, role: null }))
    const revoked = await app.request(
      `${BASE}/api/items`,
      { headers: { authorization: `Bearer ${token}` } },
      productionEnv,
    )
    expect(revoked.status).toBe(401)
  })

  it('503 not_synced when the org row has not been synced yet', async () => {
    const token = await rawToken(`org_never_synced_${crypto.randomUUID()}`)
    const res = await SELF.fetch(`${BASE}/api/items`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not_synced' })
  })

  it('403 org_disabled when the synced org is disabled', async () => {
    const orgId = `org_disabled_${crypto.randomUUID()}`
    const up = await upsertOrg({ id: orgId, name: 'Disabled Co', isDisabled: true })
    expect(up.status).toBe(200)
    const token = await rawToken(orgId)
    const res = await SELF.fetch(`${BASE}/api/items`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'org_disabled' })
  })

  it('re-enabling via upsert lifts the 403 immediately (per-request check)', async () => {
    const orgId = `org_toggle_${crypto.randomUUID()}`
    await upsertOrg({ id: orgId, name: 'Toggle Co', isDisabled: true })
    const token = await rawToken(orgId)
    const headers = { authorization: `Bearer ${token}` }
    expect((await SELF.fetch(`${BASE}/api/items`, { headers })).status).toBe(403)
    await upsertOrg({ id: orgId, name: 'Toggle Co', isDisabled: false })
    expect((await SELF.fetch(`${BASE}/api/items`, { headers })).status).toBe(200)
  })

  it('rejects a token signed with the wrong secret (401)', async () => {
    const token = await signJwt(
      { sub: 'x', org: 'org_test', email: 'x@example.com', role: 'staff', exp: 2_000_000_000 },
      'wrong-secret',
      'HS256',
    )
    const res = await SELF.fetch(`${BASE}/api/items`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('rejects an admin-audience token at the domain API boundary (401)', async () => {
    const org = `org-audience-${crypto.randomUUID()}`
    await authHeaders(org)
    const adminAudienceToken = await signAccessToken(
      { sub: `test:${org}`, org, email: 'test@example.com', role: 'staff' },
      TEST_PRIVATE_KEY,
    )
    const res = await SELF.fetch(`${BASE}/api/items`, {
      headers: { authorization: `Bearer ${adminAudienceToken}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('dev token grant (/api/auth/token)', () => {
  it('認証 JSON の body 上限を超える要求は処理前に 413', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org-large', padding: 'x'.repeat(20_000) }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
  })

  it('accepts role/email defaults and returns a usable token', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_grant' }),
    })
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const items = await SELF.fetch(`${BASE}/api/items`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(items.status).toBe(200)
  })

  it('rejects an invalid body with 400', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('example_service internal org-sync routes (service-binding only)', () => {
  it('rejects without the internal key (401)', async () => {
    const res = await SELF.fetch(`${BASE}/api/internal/organizations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'o1',
        name: 'Acme',
        version: 1,
        createdAt: new Date().toISOString(),
      }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a key for another service-binding direction (401)', async () => {
    const res = await SELF.fetch(`${BASE}/api/internal/organizations`, {
      method: 'POST',
      headers: { ...INTERNAL, 'x-internal-key': 'dev-domain-to-notifier-key-000000000000' },
      body: JSON.stringify({
        id: 'o-wrong-key',
        name: 'Acme',
        version: 1,
        createdAt: new Date().toISOString(),
      }),
    })
    expect(res.status).toBe(401)
  })

  it('upserts a synced org with the internal key (idempotent) and lists it back', async () => {
    const orgId = `o-sync-${crypto.randomUUID()}`
    const r1 = await upsertOrg({ id: orgId, name: 'Acme', plan: 'free' })
    expect(r1.status).toBe(200)
    const r2 = await upsertOrg({ id: orgId, name: 'Acme Renamed', plan: 'contracted' })
    expect(r2.status).toBe(200)

    const list = await SELF.fetch(`${BASE}/api/internal/organizations`, {
      headers: { 'x-internal-key': 'dev-admin-to-example-service-key-000000000000' },
    })
    expect(list.status).toBe(200)
    const rows = (await list.json()) as Array<{ id: string; name: string; plan: string }>
    const row = rows.find((r) => r.id === orgId)
    expect(row).toMatchObject({ name: 'Acme Renamed', plan: 'contracted' })
  })

  it('GET list rejects without the internal key (401)', async () => {
    const res = await SELF.fetch(`${BASE}/api/internal/organizations`)
    expect(res.status).toBe(401)
  })
})

describe('edge branches (coverage of fail-closed paths)', () => {
  it('legacy sync rows with NULL state fail closed (resolver + internal GET)', async () => {
    // 旧スキーマ由来の行(plan/is_disabled が NULL)を直接挿入して安全側を確認。
    const orgId = `o-legacy-${crypto.randomUUID()}`
    await env.DB.prepare(
      'INSERT INTO organizations (id, name, version, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(orgId, 'Legacy Org', 1, new Date().toISOString())
      .run()

    const token = await rawToken(orgId)
    const res = await SELF.fetch(`${BASE}/api/items`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(503) // 不完全な同期行を有効テナントとして扱わない

    const list = await SELF.fetch(`${BASE}/api/internal/organizations`, {
      headers: { 'x-internal-key': 'dev-admin-to-example-service-key-000000000000' },
    })
    const rows = (await list.json()) as Array<{ id: string; plan: string }>
    expect(rows.find((r) => r.id === orgId)).toBeUndefined()
  })

  it('dev grant is fail-closed: 404 when AUTH_DEV_GRANT is not "true"', async () => {
    const { default: worker } = await import('../src/worker/index')
    const res = await worker.request(
      '/api/auth/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_x' }),
      },
      { ...env, AUTH_DEV_GRANT: 'false' },
    )
    expect(res.status).toBe(404)
  })

  it('unexpected throws map to JSON 500 internal_error (onError)', async () => {
    const { default: worker } = await import('../src/worker/index')
    const token = await rawToken('org_boom')
    // DB binding を欠いた env で resolver を落とす → onError の 500 経路。
    const res = await worker.request(
      '/api/items',
      { headers: { authorization: `Bearer ${token}` } },
      { ...env, DB: undefined },
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'internal_error' })
  })
})
