import { afterEach, describe, expect, it, vi } from 'vitest'
import * as transport from './transport'

describe('example service Web transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exposes the Web fetch adapter', () => {
    expect(transport.platformFetch).toBeTypeOf('function')
  })

  it('uses same-origin browser fetch with redirects disabled', async () => {
    const browserFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', browserFetch)

    const response = await transport.platformFetch('/api/items', { method: 'GET' })

    expect(response.status).toBe(200)
    expect(browserFetch).toHaveBeenCalledWith('/api/items', {
      method: 'GET',
      redirect: 'error',
    })
  })

  it.each([
    ['https://evil.example/api/items', 'cross-origin URL'],
    ['//evil.example/api/items', 'protocol-relative URL'],
    ['/outside/items', 'non-API path'],
  ])('rejects %s (%s)', async (path) => {
    const browserFetch = vi.fn()
    vi.stubGlobal('fetch', browserFetch)

    await expect(transport.platformFetch(path)).rejects.toThrow('same-origin /api/ path')
    expect(browserFetch).not.toHaveBeenCalled()
  })
})
