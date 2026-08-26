import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

function tauriWindow(): TauriWindow {
  return window as TauriWindow
}

async function loadTransport() {
  vi.resetModules()
  return import('./transport')
}

describe('platformFetch', () => {
  beforeEach(() => {
    invoke.mockReset()
    delete tauriWindow().__TAURI_INTERNALS__
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete tauriWindow().__TAURI_INTERNALS__
  })

  it('keeps relative paths and uses browser fetch without invoking Tauri', async () => {
    const browserFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', browserFetch)
    const { platformFetch } = await loadTransport()

    await platformFetch('/api/organizations?active=true', {
      method: 'GET',
      headers: { authorization: 'Bearer browser-token' },
    })

    expect(browserFetch).toHaveBeenCalledWith('/api/organizations?active=true', {
      method: 'GET',
      headers: { authorization: 'Bearer browser-token' },
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('invokes api_request with the native contract and redacts set-cookie', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'refresh=secret; HttpOnly',
      },
      body: '{"ok":true}',
    })
    const { platformFetch } = await loadTransport()

    const response = await platformFetch('/api/auth/login', {
      method: 'POST',
      headers: {
        authorization: 'Bearer access-token',
        'content-type': 'application/json',
      },
      body: '{"email":"admin@example.com"}',
    })

    expect(invoke).toHaveBeenCalledWith('api_request', {
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        authorization: 'Bearer access-token',
        'content-type': 'application/json',
      },
      body: '{"email":"admin@example.com"}',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"ok":true}')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.has('set-cookie')).toBe(false)
  })

  it('accepts a same-origin Request and applies init overrides before IPC', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({ status: 200, headers: {}, body: '' })
    const { platformFetch } = await loadTransport()
    const request = new Request(new URL('/api/auth/login', window.location.origin), {
      method: 'POST',
      headers: {
        authorization: 'Bearer old',
        'content-type': 'text/plain',
      },
      body: 'old-body',
    })

    await platformFetch(request, {
      method: 'PATCH',
      headers: { authorization: 'Bearer new' },
      body: 'new-body',
    })

    expect(invoke).toHaveBeenCalledWith('api_request', {
      method: 'PATCH',
      path: '/api/auth/login',
      headers: {
        authorization: 'Bearer new',
        'content-type': 'text/plain',
      },
      body: 'new-body',
    })
  })

  it('rejects a cross-origin Request before invoking Tauri', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()
    const request = new Request('https://evil.example/api/organizations')

    await expect(platformFetch(request)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['/api', 'missing trailing slash'],
    ['api/organizations', 'non-relative path'],
    ['https://evil.example/api/organizations', 'absolute URL'],
    ['//evil.example/api/organizations', 'protocol-relative URL'],
    ['/other/organizations', 'non-API path'],
    ['/api/../organizations', 'parent path segment'],
    ['/api/%2e%2e/organizations', 'encoded parent path segment'],
    ['/api/organizations\\admin', 'backslash path'],
  ])('rejects %s (%s) before invoking Tauri', async (path) => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch(path)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['PUT', 'HEAD', 'OPTIONS'])(
    'rejects unsupported method %s before IPC',
    async (method) => {
      tauriWindow().__TAURI_INTERNALS__ = {}
      const { platformFetch } = await loadTransport()

      await expect(platformFetch('/api/organizations', { method })).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    },
  )

  it.each(['cookie', 'host', 'origin', 'set-cookie', 'x-request-id'])(
    'rejects forbidden request header %s before IPC',
    async (header) => {
      tauriWindow().__TAURI_INTERNALS__ = {}
      const { platformFetch } = await loadTransport()

      await expect(
        platformFetch('/api/organizations', { headers: { [header]: 'forbidden' } }),
      ).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    },
  )
})
