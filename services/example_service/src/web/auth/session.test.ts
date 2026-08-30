import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadSession() {
  vi.resetModules()
  return import('./session')
}

describe('example service Web auth session', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('stores the development session in sessionStorage and attaches its bearer token', async () => {
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
  })

  it('clears the persisted Web session on logout', async () => {
    sessionStorage.setItem('app.auth.token', 'browser-token')
    sessionStorage.setItem('app.auth.org', 'org_acme')
    const session = await loadSession()

    session.auth.logout()

    expect(session.auth.getToken()).toBeNull()
    expect(session.auth.getOrganization()).toBeNull()
  })
})
