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

describe('example service platformFetch', () => {
  const invalidWebRequests: Array<[string, RequestInit, string]> = [
    ['/admin/items', {}, 'non-API path'],
    ['/api/../items', {}, 'parent path segment'],
    ['/api/items', { method: 'PUT' }, 'unsupported method'],
    ['/api/items', { headers: { cookie: 'refresh=secret' } }, 'forbidden header'],
    ['/api/items', { redirect: 'follow' }, 'redirect mode'],
    ['/api/items%2Fsecret', {}, 'encoded slash path'],
    ['/api/items%3Fsecret', {}, 'encoded query delimiter'],
    ['/api/items%23secret', {}, 'encoded fragment delimiter'],
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

  it('uses browser fetch for the existing relative API contract', async () => {
    const browserFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', browserFetch)
    const { platformFetch } = await loadTransport()

    await platformFetch('/api/items', { method: 'GET' })

    expect(browserFetch).toHaveBeenCalledWith('/api/items', {
      method: 'GET',
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

  it('uses native IPC and does not expose response cookies to the renderer', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'session=secret; HttpOnly',
        'set-cookie2': 'session2=secret',
        location: 'https://evil.example',
      },
      body: '{"items":[]}',
    })
    const { platformFetch } = await loadTransport()

    const response = await platformFetch('/api/items', {
      method: 'GET',
      headers: { authorization: 'Bearer native-token' },
    })

    expect(invoke).toHaveBeenCalledWith('api_request', {
      method: 'GET',
      path: '/api/items',
      headers: { authorization: 'Bearer native-token' },
      body: null,
    })
    expect(await response.text()).toBe('{"items":[]}')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(response.headers.has('set-cookie2')).toBe(false)
    expect(response.headers.has('location')).toBe(false)
  })

  it.each([
    ['/api', 'missing trailing slash'],
    ['api/items', 'non-relative path'],
    ['https://evil.example/api/items', 'absolute URL'],
    ['//evil.example/api/items', 'protocol-relative URL'],
    ['/other/items', 'non-API path'],
    ['/api/../items', 'parent path segment'],
    ['/api/items/../secret', 'inner parent path segment'],
    ['/api/%2e%2e/items', 'encoded parent path segment'],
    ['/api/%252e%252e/items', 'double-encoded parent path segment'],
    ['/api/%255cadmin', 'double-encoded backslash path'],
    ['/api/items%5Cadmin', 'encoded backslash path'],
    ['/api/items\\admin', 'backslash path'],
  ])('rejects %s (%s) before native IPC', async (path) => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch(path)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects URL objects even when they point at the API origin', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch(new URL('http://localhost/api/items'))).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['PUT', 'HEAD', 'OPTIONS'])('rejects unsupported method %s', async (method) => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch('/api/items', { method })).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['cookie', 'host', 'origin', 'set-cookie', 'x-request-id'])(
    'rejects forbidden request header %s',
    async (header) => {
      tauriWindow().__TAURI_INTERNALS__ = {}
      const { platformFetch } = await loadTransport()

      await expect(
        platformFetch('/api/items', { headers: { [header]: 'forbidden' } }),
      ).rejects.toThrow()
      expect(invoke).not.toHaveBeenCalled()
    },
  )

  it('rejects oversized native IPC fields before invoking Tauri', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch(`/api/${'a'.repeat(2044)}`)).rejects.toThrow()
    await expect(
      platformFetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(1_048_577),
      }),
    ).rejects.toThrow()
    await expect(
      platformFetch('/api/items', {
        headers: { authorization: `Bearer ${'x'.repeat(8_193)}` },
      }),
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects oversized method and native response header envelopes', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch('/api/items', { method: 'X'.repeat(17) })).rejects.toThrow(
      'method is too large',
    )

    invoke.mockResolvedValue({
      status: 200,
      headers: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-${index}`, 'v'])),
      body: '',
    })
    await expect(platformFetch('/api/items')).rejects.toThrow('too many headers')
  })

  it('bounds a Request stream before sending it over IPC', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()
    const request = new Request(new URL('/api/items', window.location.origin), {
      method: 'POST',
      body: 'x'.repeat(1_048_577),
    })

    await expect(platformFetch(request)).rejects.toThrow('body is too large')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('checks a browser Request body before sending the original Request', async () => {
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)
    const request = new Request(new URL('/api/items', window.location.origin), {
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

    await expect(platformFetch('/api/items')).rejects.toThrow('response body is too large')
  })

  it('rejects redirect-like native responses', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({
      status: 302,
      headers: { location: 'https://evil.example' },
      body: '',
    })
    const { platformFetch } = await loadTransport()

    await expect(platformFetch('/api/items')).rejects.toThrow('redirects')
  })

  it.each([204, 205])('does not expose a native response body for %s', async (status) => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({ status, headers: {}, body: 'invalid-body' })
    const { platformFetch } = await loadTransport()

    const response = await platformFetch('/api/items')
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
  })
})
