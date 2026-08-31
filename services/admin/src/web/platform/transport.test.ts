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
  const invalidWebRequests: Array<[string, RequestInit, string]> = [
    ['/admin/organizations', {}, 'non-API path'],
    ['/api/../admin', {}, 'parent path segment'],
    ['/api/organizations', { method: 'PUT' }, 'unsupported method'],
    ['/api/organizations', { headers: { cookie: 'refresh=secret' } }, 'forbidden header'],
    ['/api/organizations', { redirect: 'follow' }, 'redirect mode'],
    ['/api/organizations%2Fsecret', {}, 'encoded slash path'],
    ['/api/organizations%3Fsecret', {}, 'encoded query delimiter'],
    ['/api/organizations%23secret', {}, 'encoded fragment delimiter'],
  ]

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
      redirect: 'error',
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(invalidWebRequests)(
    'applies native request restrictions to browser fallback: %s (%s)',
    async (path, init) => {
      const browserFetch = vi.fn()
      vi.stubGlobal('fetch', browserFetch)
      const { platformFetch } = await loadTransport()

      await expect(platformFetch(path, init)).rejects.toThrow()
      expect(browserFetch).not.toHaveBeenCalled()
      expect(invoke).not.toHaveBeenCalled()
    },
  )

  it('invokes api_request with the native contract and redacts set-cookie', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'refresh=secret; HttpOnly',
        'set-cookie2': 'refresh2=secret',
        location: 'https://evil.example',
        server: 'origin-detail',
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
    expect(response.headers.has('set-cookie2')).toBe(false)
    expect(response.headers.has('location')).toBe(false)
    expect(response.headers.has('server')).toBe(false)
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
    ['/api/organizations/../secret', 'inner parent path segment'],
    ['/api/%2e%2e/organizations', 'encoded parent path segment'],
    ['/api/%252e%252e/organizations', 'double-encoded parent path segment'],
    ['/api/%255cadmin', 'double-encoded backslash path'],
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

  it('rejects oversized native IPC fields before invoking Tauri', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch(`/api/${'a'.repeat(2044)}`, { method: 'GET' })).rejects.toThrow()
    await expect(
      platformFetch('/api/organizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(1_048_577),
      }),
    ).rejects.toThrow()
    await expect(
      platformFetch('/api/organizations', {
        headers: { authorization: `Bearer ${'x'.repeat(8_193)}` },
      }),
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects oversized method and native response header envelopes', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch('/api/organizations', { method: 'X'.repeat(17) })).rejects.toThrow(
      'method is too large',
    )

    invoke.mockResolvedValue({
      status: 200,
      headers: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-${index}`, 'v'])),
      body: '',
    })
    await expect(platformFetch('/api/organizations')).rejects.toThrow('too many headers')
  })

  it('bounds a Request stream before sending it over IPC', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()
    const request = new Request(new URL('/api/organizations', window.location.origin), {
      method: 'POST',
      body: 'x'.repeat(1_048_577),
    })

    await expect(platformFetch(request)).rejects.toThrow('body is too large')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('checks a browser Request body before sending the original Request', async () => {
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)
    const request = new Request(new URL('/api/organizations', window.location.origin), {
      method: 'POST',
      body: 'x'.repeat(1_048_577),
    })
    const { platformFetch } = await loadTransport()

    await expect(platformFetch(request)).rejects.toThrow('body is too large')
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('rejects oversized browser responses before exposing them to the app', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('', {
          status: 200,
          headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
        }),
      ),
    )
    const { platformFetch } = await loadTransport()

    await expect(platformFetch('/api/organizations')).rejects.toThrow('response body is too large')
  })

  it('rejects redirect-like native responses and filters response metadata', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({
      status: 302,
      headers: { location: 'https://evil.example', 'set-cookie2': 'secret' },
      body: '',
    })
    const { platformFetch } = await loadTransport()

    await expect(platformFetch('/api/organizations')).rejects.toThrow('redirects')
  })

  it.each([204, 205])('does not expose a native response body for %s', async (status) => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({ status, headers: {}, body: 'invalid-body' })
    const { platformFetch } = await loadTransport()

    const response = await platformFetch('/api/organizations')
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
  })
})
