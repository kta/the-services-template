import { afterEach, describe, expect, it, vi } from 'vitest'

const shared = vi.hoisted(() => ({ stretchPassword: vi.fn() }))

vi.mock('@app/shared', () => shared)

async function loadSession() {
  vi.resetModules()
  return import('./session')
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jwt(exp?: number): string {
  const payload = exp === undefined ? {} : { exp }
  return `header.${btoa(JSON.stringify(payload)).replace(/=/g, '')}.signature`
}

describe('admin browser session', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('logs in with a stretched password and attaches its bearer token', async () => {
    shared.stretchPassword.mockResolvedValue('stretched')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'access-token' }))
      .mockResolvedValueOnce(json({}))
    vi.stubGlobal('fetch', fetch)
    const session = await loadSession()
    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)

    await session.login('admin@example.com', 'password')
    const response = await session.authFetch('/api/organizations')
    unsubscribe()

    expect(shared.stretchPassword).toHaveBeenCalledWith('password', 'admin@example.com')
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', stretched: 'stretched' }),
    })
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer access-token',
    )
    expect(response.ok).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('refreshes once after an unauthorized request and retries with the new token', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json({ token: 'renewed' }))
      .mockResolvedValueOnce(json({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    const session = await loadSession()

    const response = await session.authFetch('/api/protected')

    expect(response.ok).toBe(true)
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/refresh', { method: 'POST' })
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('authorization')).toBe(
      'Bearer renewed',
    )
  })

  it('clears the in-memory token when a retry refresh is rejected', async () => {
    shared.stretchPassword.mockResolvedValue('stretched')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'access-token' }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const session = await loadSession()

    await session.login('admin@example.com', 'password')
    const response = await session.authFetch('/api/protected')

    expect(response.status).toBe(401)
    expect(session.isAuthenticated()).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('uses a valid development token when refresh cannot restore a session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'))
    sessionStorage.setItem('app.admin.dev.token', jwt(1_893_456_000))
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const session = await loadSession()

    expect(await session.bootstrap()).toBe(true)
    expect(session.isAuthenticated()).toBe(true)
  })

  it('discards an expired development token and handles refresh network failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'))
    sessionStorage.setItem('app.admin.dev.token', jwt(1_577_836_800))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const session = await loadSession()

    expect(await session.bootstrap()).toBe(false)
    expect(sessionStorage.getItem('app.admin.dev.token')).toBeNull()
  })

  it('retries a rotation race before treating refresh as a signed-out session', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'rotation_race' }, 401))
      .mockResolvedValueOnce(json({ token: 'after-race' }))
    vi.stubGlobal('fetch', fetch)
    vi.useFakeTimers()
    const session = await loadSession()
    const pending = session.bootstrap()
    await vi.advanceTimersByTimeAsync(250)

    expect(await pending).toBe(true)
    vi.useRealTimers()
  })

  it('accepts invitations, supports the development grant, and clears state on logout', async () => {
    shared.stretchPassword.mockResolvedValue('stretched')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'invite-token' }))
      .mockResolvedValueOnce(json({ token: 'dev-token' }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    const session = await loadSession()

    await session.acceptInvite('invite', 'staff@example.com', 'password')
    expect(session.isAuthenticated()).toBe(true)
    expect(await session.devLogin('org-admin')).toBe(true)
    expect(sessionStorage.getItem('app.admin.dev.token')).toBe('dev-token')
    await session.logout()
    expect(session.isAuthenticated()).toBe(false)
    expect(sessionStorage.getItem('app.admin.dev.token')).toBeNull()
  })

  it('exposes failed API logins as status-bearing errors', async () => {
    shared.stretchPassword.mockResolvedValue('stretched')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    const session = await loadSession()

    await expect(session.login('admin@example.com', 'password')).rejects.toMatchObject({
      status: 403,
    })
  })
})
