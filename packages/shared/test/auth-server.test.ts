import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  type AuthVariables,
  type DomainSessionEnv,
  requireActiveOrg,
  requireLiveDomainSession,
  requirePlan,
  requireRole,
  tenantAuth,
} from '../src/auth-server'
import { signAccessToken } from '../src/jwt'
import { JWT_TEST_PRIVATE_KEY, JWT_TEST_PUBLIC_KEY } from './jwt-keys'

type Env = { Bindings: { JWT_PUBLIC_KEY: string }; Variables: AuthVariables }
const NOW = 1_800_000_000

function bearer(token: string) {
  return { authorization: `Bearer ${token}` }
}
async function token(role: 'admin' | 'staff', org = 'o1') {
  return signAccessToken(
    { sub: 'u1', org, email: 'a@b.com', role },
    JWT_TEST_PRIVATE_KEY,
    undefined,
    NOW,
  )
}

async function domainToken(sid?: string) {
  return signAccessToken(
    { sub: 'u1', org: 'o1', email: 'a@b.com', role: 'staff', ...(sid ? { sid } : {}) },
    JWT_TEST_PRIVATE_KEY,
    undefined,
    NOW,
    'domain:booking',
  )
}

describe('tenantAuth', () => {
  const app = new Hono<Env>()
  app.use('/p', tenantAuth(NOW))
  app.get('/p', (c) => c.json(c.get('auth')))

  it('401 without a token', async () => {
    const res = await app.request('/p', {}, { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY })
    expect(res.status).toBe(401)
  })

  it('401 with a bad token', async () => {
    const res = await app.request(
      '/p',
      { headers: bearer('x.y.z') },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(401)
  })

  it('passes and exposes claims with a valid token', async () => {
    const res = await app.request(
      '/p',
      { headers: bearer(await token('staff')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ org: 'o1', role: 'staff' })
  })

  it('resolves an injected clock for each request on a warm middleware instance', async () => {
    let clock = NOW
    const app = new Hono<Env>()
    app.use(
      '/p',
      tenantAuth(() => clock),
    )
    app.get('/p', (c) => c.json({ ok: true }))
    const shortLived = await signAccessToken(
      { sub: 'u1', org: 'o1', email: 'a@b.com', role: 'staff' },
      JWT_TEST_PRIVATE_KEY,
      1,
      NOW,
    )

    const first = await app.request(
      '/p',
      { headers: bearer(shortLived) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(first.status).toBe(200)

    clock = NOW + 1
    const afterExpiry = await app.request(
      '/p',
      { headers: bearer(shortLived) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(afterExpiry.status).toBe(401)
  })
})

describe('requireLiveDomainSession', () => {
  function make(response: Response | Error, overrides: Partial<DomainSessionEnv['Bindings']> = {}) {
    const fetch = vi.fn(async () => {
      if (response instanceof Error) throw response
      return response
    })
    const app = new Hono<DomainSessionEnv>()
    app.use('/x', tenantAuth(NOW, 'domain:booking'), requireLiveDomainSession())
    app.get('/x', (c) => c.json({ role: c.get('auth').role }))
    return {
      app,
      fetch,
      env: {
        JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY,
        APP_ENV: 'production',
        ADMIN: { fetch } as never,
        DOMAIN_TO_ADMIN_KEY: 'k'.repeat(32),
        ...overrides,
      },
    }
  }

  it('checks sid/sub/org over the domain-specific admin binding and propagates the current role', async () => {
    const { app, fetch, env } = make(Response.json({ active: true, role: 'admin' }))
    const res = await app.request(
      '/x',
      { headers: { authorization: `Bearer ${await domainToken('session-1')}` } },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: 'admin' })
    expect(fetch).toHaveBeenCalledWith(
      'http://admin/api/internal/auth/session',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-internal-key': 'k'.repeat(32),
          'x-internal-caller': 'domain',
        }),
        signal: expect.any(AbortSignal),
      }),
    )
    const init = fetch.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ sid: 'session-1', sub: 'u1', org: 'o1' })
  })

  it.each([
    ['inactive', Response.json({ active: false, role: null })],
    ['malformed', Response.json({ active: true, role: 'root' })],
    ['admin unavailable', new Error('binding down')],
  ])('%s fails closed', async (_name, response) => {
    const { app, env } = make(response)
    const res = await app.request(
      '/x',
      { headers: { authorization: `Bearer ${await domainToken('session-1')}` } },
      env,
    )
    expect(res.status).toBe(response instanceof Error ? 503 : _name === 'inactive' ? 401 : 503)
  })

  it('rejects a validly signed domain token without sid', async () => {
    const { app, env } = make(Response.json({ active: true, role: 'staff' }))
    const res = await app.request(
      '/x',
      { headers: { authorization: `Bearer ${await domainToken()}` } },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('only skips the live check for the explicit local development grant', async () => {
    const { app, fetch, env } = make(Response.json({ active: false, role: null }), {
      APP_ENV: 'development',
      AUTH_DEV_GRANT: 'true',
    })
    const res = await app.request(
      '/x',
      { headers: { authorization: `Bearer ${await domainToken('session-1')}` } },
      env,
    )
    expect(res.status).toBe(200)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('requireRole', () => {
  const app = new Hono<Env>()
  app.use('/admin', tenantAuth(NOW), requireRole('admin'))
  app.get('/admin', (c) => c.json({ ok: true }))

  it('403 for staff', async () => {
    const res = await app.request(
      '/admin',
      { headers: bearer(await token('staff')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(403)
  })
  it('200 for admin', async () => {
    const res = await app.request(
      '/admin',
      { headers: bearer(await token('admin')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(200)
  })
})

describe('requireActiveOrg', () => {
  function make(
    resolve: (id: string) => { plan: 'free' | 'contracted'; isDisabled: boolean } | null,
  ) {
    const app = new Hono<Env>()
    app.use(
      '/x',
      tenantAuth(NOW),
      requireActiveOrg(async (id) => resolve(id)),
    )
    app.get('/x', (c) => c.json(c.get('org')))
    return app
  }

  it('503 not_synced when the org row is missing', async () => {
    const res = await make(() => null).request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not_synced' })
  })
  it('403 org_disabled when disabled', async () => {
    const res = await make(() => ({ plan: 'free', isDisabled: true })).request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'org_disabled' })
  })
  it('200 and exposes org when active', async () => {
    const res = await make(() => ({ plan: 'contracted', isDisabled: false })).request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ plan: 'contracted', isDisabled: false })
  })
})

describe('requirePlan', () => {
  function make(plan: 'free' | 'contracted', role: 'admin' | 'staff') {
    const app = new Hono<Env>()
    app.use(
      '/x',
      tenantAuth(NOW),
      requireActiveOrg(async () => ({ plan, isDisabled: false })),
      requirePlan('contracted'),
    )
    app.get('/x', (c) => c.json({ ok: true }))
    return { app, role }
  }

  it('403 for staff on free plan', async () => {
    const { app } = make('free', 'staff')
    const res = await app.request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'plan_required' })
  })
  it('200 for staff on contracted plan', async () => {
    const { app } = make('contracted', 'staff')
    const res = await app.request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(200)
  })
  it('403 for admin on free plan(テナント管理者はプランゲートを免除されない)', async () => {
    // JWT role==='admin' はテナント管理者を含むため、免除すると free org の
    // 管理者が課金機能を素通りできてしまう(レビュー指摘の回帰テスト)。
    const { app } = make('free', 'admin')
    const res = await app.request(
      '/x',
      { headers: bearer(await token('admin')) },
      { JWT_PUBLIC_KEY: JWT_TEST_PUBLIC_KEY },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'plan_required' })
  })
})
