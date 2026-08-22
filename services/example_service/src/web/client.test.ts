import { auth } from '@app/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { client } from './client'

const item = {
  id: 'item-1',
  organizationId: 'org_acme',
  title: 'Shipped',
  body: 'First release',
  createdAt: '2026-08-22T00:00:00.000Z',
}

function requestFor(input: Parameters<typeof fetch>[0], init?: RequestInit): Request {
  if (input instanceof Request) return new Request(input, init)
  const url = input instanceof URL ? input : new URL(input, window.location.origin)
  return new Request(url, init)
}

describe('example service Hono client', () => {
  afterEach(() => {
    auth.logout()
    vi.unstubAllGlobals()
  })

  it('exchanges a token grant, stores authorization, and lists items through the typed client', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = requestFor(input, init)
      if (request.url.endsWith('/api/auth/token')) {
        return new Response(JSON.stringify({ token: 'token-123' }), { status: 200 })
      }
      return new Response(JSON.stringify([item]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await auth.login('org_acme')
    const response = await client.api.items.$get()

    expect(auth.getOrganization()).toBe('org_acme')
    expect(await response.json()).toEqual([item])
    const [listInput, listInit] = fetchMock.mock.calls[1] ?? []
    if (!listInput) throw new Error('list request is missing')
    const listRequest = requestFor(listInput, listInit)
    expect(listRequest.url).toContain('/api/items')
    expect(listRequest.method).toBe('GET')
    expect(listRequest.headers.get('authorization')).toBe('Bearer token-123')
  })

  it('sends the create contract as JSON and returns the successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(item), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    sessionStorage.setItem('app.auth.token', 'token-123')

    const response = await client.api.items.$post({
      json: { title: 'Shipped', body: 'First release' },
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(item)
    const [input, init] = fetchMock.mock.calls[0] ?? []
    if (!input) throw new Error('create request is missing')
    const request = requestFor(input, init)
    expect(request.url).toContain('/api/items')
    expect(request.method).toBe('POST')
    expect(request.headers.get('authorization')).toBe('Bearer token-123')
    expect(await request.json()).toEqual({ title: 'Shipped', body: 'First release' })
  })

  it('preserves structured and unauthorized failures for the application to handle', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_item' }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const structuredFailure = await client.api.items.$get()
    const unauthorized = await client.api.items.$get()

    expect(structuredFailure.ok).toBe(false)
    expect(await structuredFailure.json()).toEqual({ error: 'invalid_item' })
    expect(unauthorized.status).toBe(401)
  })

  it('does not turn malformed response JSON into a successful payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })))

    const response = await client.api.items.$get()

    await expect(response.json()).rejects.toThrow()
  })

  it('stops sending the stored bearer token after logout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    sessionStorage.setItem('app.auth.token', 'token-123')
    auth.logout()

    await client.api.items.$get()

    const [input, init] = fetchMock.mock.calls[0] ?? []
    if (!input) throw new Error('list request is missing')
    expect(requestFor(input, init).headers.get('authorization')).toBeNull()
  })
})
