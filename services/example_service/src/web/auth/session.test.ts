import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

function tauriWindow(): TauriWindow {
  return window as TauriWindow
}

async function loadSession() {
  vi.resetModules()
  return import('./session')
}

function nativeResponse(
  body: unknown,
  status = 200,
): {
  status: number
  headers: Record<string, string>
  body: string
} {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('example service auth session', () => {
  afterEach(() => {
    invoke.mockReset()
    delete tauriWindow().__TAURI_INTERNALS__
    sessionStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the existing browser sessionStorage login and bearer behavior', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'browser-token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const session = await loadSession()

    await session.auth.login('org_acme')
    const response = await session.auth.authFetch('/api/items')

    expect(sessionStorage.getItem('app.auth.token')).toBe('browser-token')
    expect(sessionStorage.getItem('app.auth.org')).toBe('org_acme')
    expect(session.auth.getToken()).toBe('browser-token')
    expect(session.auth.getOrganization()).toBe('org_acme')
    expect(response.ok).toBe(true)
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer browser-token',
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps native tokens in memory and routes authenticated requests through IPC', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke
      .mockResolvedValueOnce(nativeResponse({ token: 'native-token' }))
      .mockResolvedValueOnce(nativeResponse([]))
    const session = await loadSession()

    await session.auth.login('org_acme')
    const response = await session.auth.authFetch('/api/items')

    expect(sessionStorage.getItem('app.auth.token')).toBeNull()
    expect(sessionStorage.getItem('app.auth.org')).toBeNull()
    expect(session.auth.getToken()).toBe('native-token')
    expect(session.auth.getOrganization()).toBe('org_acme')
    expect(response.ok).toBe(true)
    expect(invoke).toHaveBeenNthCalledWith(1, 'api_request', {
      method: 'POST',
      path: '/api/auth/token',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_acme' }),
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'api_request', {
      method: 'GET',
      path: '/api/items',
      headers: { authorization: 'Bearer native-token' },
      body: null,
    })
  })

  it('clears native memory on logout without creating a persistent native session', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue(nativeResponse({ token: 'native-token' }))
    const session = await loadSession()

    await session.auth.login('org_acme')
    session.auth.logout()

    expect(session.auth.getToken()).toBeNull()
    expect(session.auth.getOrganization()).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })
})
