import { afterEach, describe, expect, it, vi } from 'vitest'
import { platformFetch } from './transport'

describe('example service Web transport', () => {
  const invalidRequests: Array<[string, RequestInfo | URL, RequestInit]> = [
    ['non-API path', '/admin/items', {}],
    ['absolute cross-origin URL', 'https://evil.example/api/items', {}],
    ['protocol-relative URL', '//evil.example/api/items', {}],
    ['parent path segment', '/api/../items', {}],
    ['inner parent path segment', '/api/items/../secret', {}],
    ['encoded parent path segment', '/api/%2e%2e/items', {}],
    ['double-encoded parent path segment', '/api/%252e%252e/items', {}],
    ['encoded slash', '/api/items%2Fsecret', {}],
    ['encoded query delimiter', '/api/items%3Fsecret', {}],
    ['encoded fragment delimiter', '/api/items%23secret', {}],
    ['encoded backslash', '/api/items%5Cadmin', {}],
    ['double-encoded backslash', '/api/%255cadmin', {}],
    ['literal backslash', '/api/items\\admin', {}],
    ['unsupported PUT method', '/api/items', { method: 'PUT' }],
    ['unsupported HEAD method', '/api/items', { method: 'HEAD' }],
    ['unsupported OPTIONS method', '/api/items', { method: 'OPTIONS' }],
    ['forbidden cookie header', '/api/items', { headers: { cookie: 'refresh=secret' } }],
    ['forbidden origin header', '/api/items', { headers: { origin: 'https://evil.example' } }],
    ['caller-selected redirect mode', '/api/items', { redirect: 'follow' }],
  ]

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('allows the API methods and request headers used by the Hono client', async () => {
    const browserFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', browserFetch)

    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const response = await platformFetch('/api/items', {
        method,
        headers: {
          authorization: 'Bearer browser-token',
          'content-type': 'application/json',
        },
        body: method === 'GET' ? undefined : '{}',
      })
      expect(response.status).toBe(200)
    }

    expect(browserFetch).toHaveBeenCalledTimes(4)
    expect(browserFetch).toHaveBeenNthCalledWith(1, '/api/items', {
      method: 'GET',
      headers: {
        authorization: 'Bearer browser-token',
        'content-type': 'application/json',
      },
      body: undefined,
      redirect: 'error',
    })
  })

  it.each(invalidRequests)('rejects %s before browser fetch', async (_name, input, init) => {
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)

    await expect(platformFetch(input, init)).rejects.toThrow()
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it.each(['host', 'set-cookie', 'x-request-id'])(
    'rejects forbidden request header %s',
    async (header) => {
      const browserFetch = vi.fn()
      vi.stubGlobal('fetch', browserFetch)

      await expect(
        platformFetch('/api/items', { headers: { [header]: 'forbidden' } }),
      ).rejects.toThrow('header is not allowed')
      expect(browserFetch).not.toHaveBeenCalled()
    },
  )

  it('validates a same-origin Request before preserving it for fetch', async () => {
    const browserFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', browserFetch)
    const request = new Request(new URL('/api/items', window.location.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    await platformFetch(request)

    expect(browserFetch).toHaveBeenCalledWith(request, { redirect: 'error' })
  })

  it('rejects a cross-origin Request even when its path starts with /api/', async () => {
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)
    const request = new Request('https://evil.example/api/items')

    await expect(platformFetch(request)).rejects.toThrow('same-origin')
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['init body', '/api/items', { method: 'GET', body: '{}' } satisfies RequestInit],
    [
      'Request body',
      new Request(new URL('/api/items', window.location.origin), {
        method: 'POST',
        body: '{}',
      }),
      { method: 'GET' } satisfies RequestInit,
    ],
  ])('rejects a GET %s', async (_name, input, init) => {
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)

    await expect(platformFetch(input, init)).rejects.toThrow('GET requests cannot have a body')
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('rejects oversized method, path, header, and string body fields', async () => {
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)

    await expect(platformFetch('/api/items', { method: 'X'.repeat(17) })).rejects.toThrow(
      'method is too large',
    )
    await expect(platformFetch(`/api/${'a'.repeat(2044)}`)).rejects.toThrow('path is too large')
    await expect(
      platformFetch('/api/items', {
        headers: { authorization: `Bearer ${'x'.repeat(8_193)}` },
      }),
    ).rejects.toThrow('header is too large')
    await expect(
      platformFetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(1_048_577),
      }),
    ).rejects.toThrow('body is too large')
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('bounds a Request stream before sending the original Request', async () => {
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)
    const request = new Request(new URL('/api/items', window.location.origin), {
      method: 'POST',
      body: 'x'.repeat(1_048_577),
    })

    await expect(platformFetch(request)).rejects.toThrow('body is too large')
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['declared content length', new Response('', { headers: { 'content-length': '4194305' } })],
    [
      'streamed body',
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
            controller.close()
          },
        }),
      ),
    ],
  ])('rejects an oversized browser response with %s', async (_name, upstream) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream))

    await expect(platformFetch('/api/items')).rejects.toThrow('response body is too large')
  })

  it('exposes only allowlisted, bounded response headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"items":[]}', {
          status: 200,
          headers: {
            'cache-control': 'private',
            'content-type': 'application/json',
            etag: 'v1',
            'retry-after': '5',
            'x-request-id': 'request-1',
            'set-cookie': 'session=secret; HttpOnly',
            location: 'https://evil.example',
            'x-unreviewed': 'hidden',
            'x-oversized': 'x'.repeat(8_193),
          },
        }),
      ),
    )

    const response = await platformFetch('/api/items')

    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'private',
      'content-type': 'application/json',
      etag: 'v1',
      'retry-after': '5',
      'x-request-id': 'request-1',
    })
    expect(await response.json()).toEqual({ items: [] })
  })

  it('drops an oversized allowlisted response header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'x'.repeat(8_193),
          },
        }),
      ),
    )

    const response = await platformFetch('/api/items')

    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'application/json',
    })
  })

  it.each([301, 302, 307, 308])('rejects redirect-like browser response %s', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status, headers: { location: 'https://evil.example' } }),
        ),
    )

    await expect(platformFetch('/api/items')).rejects.toThrow('redirects')
  })

  it.each([204, 205])('does not expose a browser response body for %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })))

    const response = await platformFetch('/api/items')

    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
  })
})
