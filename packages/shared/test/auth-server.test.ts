import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  type AuthVariables,
  requireActiveOrg,
  requirePlan,
  requireRole,
  tenantAuth,
} from '../src/auth-server'
import { signAccessToken } from '../src/jwt'

const SECRET = 'test-secret'
type Env = { Bindings: { JWT_SECRET: string }; Variables: AuthVariables }

function bearer(token: string) {
  return { authorization: `Bearer ${token}` }
}
async function token(role: 'admin' | 'staff', org = 'o1') {
  return signAccessToken({ sub: 'u1', org, email: 'a@b.com', role }, SECRET)
}

describe('tenantAuth', () => {
  const app = new Hono<Env>()
  app.use('/p', tenantAuth())
  app.get('/p', (c) => c.json(c.get('auth')))

  it('401 without a token', async () => {
    const res = await app.request('/p', {}, { JWT_SECRET: SECRET })
    expect(res.status).toBe(401)
  })

  it('401 with a bad token', async () => {
    const res = await app.request('/p', { headers: bearer('x.y.z') }, { JWT_SECRET: SECRET })
    expect(res.status).toBe(401)
  })

  it('passes and exposes claims with a valid token', async () => {
    const res = await app.request(
      '/p',
      { headers: bearer(await token('staff')) },
      { JWT_SECRET: SECRET },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ org: 'o1', role: 'staff' })
  })
})

describe('requireRole', () => {
  const app = new Hono<Env>()
  app.use('/admin', tenantAuth(), requireRole('admin'))
  app.get('/admin', (c) => c.json({ ok: true }))

  it('403 for staff', async () => {
    const res = await app.request(
      '/admin',
      { headers: bearer(await token('staff')) },
      { JWT_SECRET: SECRET },
    )
    expect(res.status).toBe(403)
  })
  it('200 for admin', async () => {
    const res = await app.request(
      '/admin',
      { headers: bearer(await token('admin')) },
      { JWT_SECRET: SECRET },
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
      tenantAuth(),
      requireActiveOrg(async (id) => resolve(id)),
    )
    app.get('/x', (c) => c.json(c.get('org')))
    return app
  }

  it('503 not_synced when the org row is missing', async () => {
    const res = await make(() => null).request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_SECRET: SECRET },
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not_synced' })
  })
  it('403 org_disabled when disabled', async () => {
    const res = await make(() => ({ plan: 'free', isDisabled: true })).request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_SECRET: SECRET },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'org_disabled' })
  })
  it('200 and exposes org when active', async () => {
    const res = await make(() => ({ plan: 'contracted', isDisabled: false })).request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_SECRET: SECRET },
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
      tenantAuth(),
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
      { JWT_SECRET: SECRET },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'plan_required' })
  })
  it('200 for staff on contracted plan', async () => {
    const { app } = make('contracted', 'staff')
    const res = await app.request(
      '/x',
      { headers: bearer(await token('staff')) },
      { JWT_SECRET: SECRET },
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
      { JWT_SECRET: SECRET },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'plan_required' })
  })
})
