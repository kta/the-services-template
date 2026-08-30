import type { Organization } from '@app/contracts'
import type { Fetcher } from '@cloudflare/workers-types'
import { describe, expect, it, vi } from 'vitest'
import {
  configuredDomainSyncEnvironments,
  listDomainOrgs,
  syncOrgToDomain,
  syncOrgToDomains,
} from '../src/worker/sync'

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
    const result = await syncOrgToDomain(
      {
        directory: 'example_service',
        binding: { fetch } as unknown as Fetcher,
        key: 'k'.repeat(32),
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
        directory: 'example_service',
        binding: { fetch } as unknown as Fetcher,
        key: 'k'.repeat(32),
      }),
    ).rejects.toThrow('domain unavailable')
  })

  it('returns no runtime targets and treats sync as complete when no domain is deployed', async () => {
    const targets = configuredDomainSyncEnvironments({ ADMIN_DOMAIN_IDENTITIES: '[]' })
    expect(targets).toEqual([])
    await expect(syncOrgToDomains(targets, org)).resolves.toBe(true)
  })

  it('resolves the convention-bound Fetcher and caller key from the reviewed runtime identity', () => {
    const { fetch } = binding(Response.json(org))
    const targets = configuredDomainSyncEnvironments({
      ADMIN_DOMAIN_IDENTITIES: JSON.stringify([
        {
          directory: 'booking',
          binding: 'BOOKING',
          secret: 'ADMIN_TO_BOOKING_KEY',
        },
      ]),
      BOOKING: { fetch },
      ADMIN_TO_BOOKING_KEY: 'k'.repeat(32),
    })
    expect(targets).toEqual([
      {
        directory: 'booking',
        binding: { fetch },
        key: 'k'.repeat(32),
      },
    ])
  })

  it('fails closed when the reviewed runtime identity does not resolve its binding or secret', () => {
    expect(() =>
      configuredDomainSyncEnvironments({
        ADMIN_DOMAIN_IDENTITIES: JSON.stringify([
          {
            directory: 'booking',
            binding: 'BOOKING',
            secret: 'ADMIN_TO_BOOKING_KEY',
          },
        ]),
        ADMIN_TO_BOOKING_KEY: 'k'.repeat(32),
      }),
    ).toThrow(/BOOKING.*Fetcher/i)
  })
})
