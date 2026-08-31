import { afterEach, describe, expect, it, vi } from 'vitest'

const shared = vi.hoisted(() => ({ stretchPassword: vi.fn() }))
const invoke = vi.hoisted(() => vi.fn())

vi.mock('@app/shared', () => shared)
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

function tauriWindow(): TauriWindow {
  return window as TauriWindow
}

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
    invoke.mockReset()
    delete tauriWindow().__TAURI_INTERNALS__
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    sessionStorage.clear()
    localStorage.clear()
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
      redirect: 'error',
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
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/refresh', {
      method: 'POST',
      redirect: 'error',
    })
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

  it('blocks cookie refresh after an offline browser logout until an explicit login succeeds', async () => {
    shared.stretchPassword.mockResolvedValue('stretched')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'browser-token' }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    const session = await loadSession()

    await session.login('admin@example.com', 'password')
    await session.logout()
    expect(localStorage.getItem('app.admin.logout.intent')).toBe('1')

    const reloaded = await loadSession()
    fetch.mockClear()
    await expect(reloaded.bootstrap()).resolves.toBe(false)
    expect(fetch).not.toHaveBeenCalled()

    fetch.mockResolvedValueOnce(json({ token: 'logged-in-again' }))
    await reloaded.login('admin@example.com', 'password')
    expect(localStorage.getItem('app.admin.logout.intent')).toBeNull()
  })

  it('fails closed when an offline logout cannot persist its browser tombstone', async () => {
    shared.stretchPassword.mockResolvedValue('stretched')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'browser-token' }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const session = await loadSession()

    await session.login('admin@example.com', 'password')
    await expect(session.logout()).rejects.toMatchObject({ name: 'LogoutError' })
    expect(session.isAuthenticated()).toBe(false)
    await expect(session.bootstrap()).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the browser logout tombstone cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const session = await loadSession()

    await expect(session.bootstrap()).resolves.toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not let an in-flight refresh resurrect a session after logout', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementationOnce(() => refreshResponse)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const session = await loadSession()

    const request = session.authFetch('/api/protected')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const logout = session.logout()
    await expect(
      session.authFetch('/api/mutation', { headers: { authorization: 'Bearer old' } }),
    ).rejects.toMatchObject({
      name: 'LogoutError',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    resolveRefresh?.(json({ token: 'must-not-be-installed' }))

    await expect(request).resolves.toMatchObject({ status: 401 })
    await logout

    expect(session.isAuthenticated()).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/auth/logout')
  })

  it('exposes failed API logins as status-bearing errors', async () => {
    shared.stretchPassword.mockResolvedValue('stretched')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    const session = await loadSession()

    await expect(session.login('admin@example.com', 'password')).rejects.toMatchObject({
      status: 403,
    })
  })

  it('uses the Tauri transport for native login requests', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    shared.stretchPassword.mockResolvedValue('stretched')
    invoke.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'native-token' }),
    })
    const session = await loadSession()

    await session.login('admin@example.com', 'password')

    expect(invoke).toHaveBeenCalledWith('api_request', {
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', stretched: 'stretched' }),
    })
    expect(session.isAuthenticated()).toBe(true)
  })

  it('uses the Tauri transport for native refresh and hides refresh cookies from JS', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({
      status: 200,
      headers: { 'set-cookie': 'refresh=secret; HttpOnly' },
      body: JSON.stringify({ token: 'refreshed-native-token' }),
    })
    const session = await loadSession()

    await expect(session.bootstrap()).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith('api_request', {
      method: 'POST',
      path: '/api/auth/refresh',
      headers: {},
      body: null,
    })
    expect(session.isAuthenticated()).toBe(true)
  })

  it('does not restore or persist development tokens in Tauri session storage', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    sessionStorage.setItem('app.admin.dev.token', jwt(1_893_456_000))
    invoke
      .mockResolvedValueOnce({ status: 401, headers: {}, body: '{"error":"unauthorized"}' })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ token: 'dev-native-token' }),
      })
    const session = await loadSession()

    await expect(session.bootstrap()).resolves.toBe(false)
    expect(sessionStorage.getItem('app.admin.dev.token')).toBeNull()
    await expect(session.devLogin('org-admin')).resolves.toBe(true)
    expect(sessionStorage.getItem('app.admin.dev.token')).toBeNull()
  })

  it('uses native IPC for invite, development login, and logout failure clears memory', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    shared.stretchPassword.mockResolvedValue('stretched')
    invoke
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'set-cookie': 'refresh=invite-secret; HttpOnly' },
        body: JSON.stringify({ token: 'invite-native-token' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ token: 'dev-native-token' }),
      })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)
    const session = await loadSession()

    await session.acceptInvite('invite', 'staff@example.com', 'password')
    await expect(session.devLogin('org-admin')).resolves.toBe(true)
    await session.logout()

    expect(invoke).toHaveBeenNthCalledWith(1, 'api_request', {
      method: 'POST',
      path: '/api/auth/accept-invite',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'invite', email: 'staff@example.com', stretched: 'stretched' }),
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'api_request', {
      method: 'POST',
      path: '/api/auth/token',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org-admin', role: 'admin' }),
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'api_request', {
      method: 'POST',
      path: '/api/auth/logout',
      headers: {},
      body: null,
    })
    expect(invoke).toHaveBeenNthCalledWith(4, 'clear_session')
    expect(session.isAuthenticated()).toBe(false)
  })

  it('serializes login and logout so a late login cannot restore a cleared session', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    shared.stretchPassword.mockResolvedValue('stretched')
    let resolveLogin: ((value: unknown) => void) | undefined
    invoke
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLogin = resolve
        }),
      )
      .mockResolvedValueOnce({ status: 204, headers: {}, body: '' })
      .mockResolvedValueOnce(undefined)
    const session = await loadSession()

    const login = session.login('admin@example.com', 'password')
    const logout = session.logout()
    resolveLogin?.({
      status: 200,
      headers: {},
      body: JSON.stringify({ token: 'late-login-token' }),
    })

    await login
    await logout

    expect(session.isAuthenticated()).toBe(false)
    expect(invoke).toHaveBeenNthCalledWith(2, 'api_request', {
      method: 'POST',
      path: '/api/auth/logout',
      headers: {},
      body: null,
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'clear_session')
  })

  it('reports a native protected-store clear failure after clearing renderer state', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    shared.stretchPassword.mockResolvedValue('stretched')
    invoke
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ token: 'native-token' }),
      })
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('keyring unavailable'))
    const session = await loadSession()

    await session.login('admin@example.com', 'password')
    await expect(session.logout()).rejects.toMatchObject({ name: 'LogoutError' })
    expect(session.isAuthenticated()).toBe(false)
    expect(invoke).toHaveBeenNthCalledWith(2, 'api_request', {
      method: 'POST',
      path: '/api/auth/logout',
      headers: {},
      body: null,
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'clear_session')
  })
})
