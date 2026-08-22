import { describe, expect, it } from 'vitest'
import { unwrap } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('unwrap', () => {
  it('returns a successful JSON body', async () => {
    await expect(unwrap<{ id: string }>(jsonResponse({ id: 'org-1' }))).resolves.toEqual({
      id: 'org-1',
    })
  })

  it('returns undefined for an empty successful response', async () => {
    await expect(unwrap<void>(new Response(null, { status: 204 }))).resolves.toBeUndefined()
  })

  it('preserves structured API error status and code', async () => {
    await expect(unwrap(jsonResponse({ error: 'email_taken' }, 409))).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'email_taken',
    })
  })

  it('uses the HTTP status code for an unknown JSON error body', async () => {
    await expect(unwrap(jsonResponse({ message: 'unavailable' }, 503))).rejects.toMatchObject({
      status: 503,
      code: 'http_503',
    })
  })

  it('uses the HTTP status code for a non-JSON error body', async () => {
    const response = new Response('temporarily unavailable', { status: 502 })

    await expect(unwrap(response)).rejects.toMatchObject({
      status: 502,
      code: 'http_502',
    })
  })
})
