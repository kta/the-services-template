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

    expect(browserFetch).toHaveBeenCalledWith('/api/items', { method: 'GET' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('uses native IPC and does not expose response cookies to the renderer', async () => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    invoke.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'session=secret; HttpOnly',
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
  })

  it.each([
    ['/api', 'missing trailing slash'],
    ['api/items', 'non-relative path'],
    ['https://evil.example/api/items', 'absolute URL'],
    ['//evil.example/api/items', 'protocol-relative URL'],
    ['/other/items', 'non-API path'],
    ['/api/../items', 'parent path segment'],
    ['/api/%2e%2e/items', 'encoded parent path segment'],
    ['/api/items\\admin', 'backslash path'],
  ])('rejects %s (%s) before native IPC', async (path) => {
    tauriWindow().__TAURI_INTERNALS__ = {}
    const { platformFetch } = await loadTransport()

    await expect(platformFetch(path)).rejects.toThrow()
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
})
