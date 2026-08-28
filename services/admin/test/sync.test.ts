import type { Organization } from '@app/contracts'
import type { Fetcher } from '@cloudflare/workers-types'
import { describe, expect, it, vi } from 'vitest'
import { listDomainOrgs, syncOrgToExampleService } from '../src/worker/sync'

const org: Organization = {
  id: 'org-1',
  name: 'Acme',
  plan: 'free',
  isDisabled: false,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
}

function binding(response: Response | Error) {
  const fetch = vi.fn(async (_input: RequestInfo, _init?: RequestInit) => {
    if (response instanceof Error) throw response
    return response.clone()
  })
  return { fetch: fetch as unknown as Fetcher, fetchSpy: fetch }
}

describe('admin → domain service binding timeout boundary', () => {
  it('adds an AbortSignal timeout to org sync requests', async () => {
    const { fetchSpy, fetch } = binding(Response.json(org))
    const result = await syncOrgToExampleService(
      {
        EXAMPLE_SERVICE: { fetch } as unknown as Fetcher,
        ADMIN_TO_EXAMPLE_SERVICE_KEY: 'k'.repeat(32),
      },
      org,
    )
    expect(result).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0]?.[1]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps reconcile reads fail-closed when the binding rejects', async () => {
    const { fetch } = binding(new Error('domain unavailable'))
    await expect(
      listDomainOrgs({
        EXAMPLE_SERVICE: { fetch } as unknown as Fetcher,
        ADMIN_TO_EXAMPLE_SERVICE_KEY: 'k'.repeat(32),
      }),
    ).rejects.toThrow('domain unavailable')
  })
})
