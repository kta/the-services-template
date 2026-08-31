import type { Organization } from '@app/contracts'
import type { Fetcher } from '@cloudflare/workers-types'
import { describe, expect, it, vi } from 'vitest'
import { orchestrateDomainSyncIdentities } from '../src/worker/domain-sync-orchestration.mjs'
import {
  configuredDomainSyncEnvironments,
  listDomainOrgs,
  resolveDomainSyncIdentity,
  syncOrgToConfiguredDomains,
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
  it('executes the exported request entry across three computed binding and secret tuples', async () => {
    const identities = [
      { directory: 'booking', binding: 'BOOKING', secret: 'ADMIN_TO_BOOKING_KEY' },
      { directory: 'inventory', binding: 'INVENTORY', secret: 'ADMIN_TO_INVENTORY_KEY' },
      { directory: 'shipping', binding: 'SHIPPING', secret: 'ADMIN_TO_SHIPPING_KEY' },
    ]
    const fetches = new Map(
      identities.map((identity) => [
        identity.directory,
        vi.fn(
          async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(null, { status: 204 }),
        ),
      ]),
    )
    const environment = Object.fromEntries([
      ['ADMIN_DOMAIN_IDENTITIES', JSON.stringify(identities)],
      ...identities.flatMap((identity) => [
        [identity.binding, { fetch: fetches.get(identity.directory) }],
        [identity.secret, `${identity.directory}-key`],
      ]),
    ])

    await expect(syncOrgToConfiguredDomains(environment, org)).resolves.toBe(true)

    for (const identity of identities) {
      const fetch = fetches.get(identity.directory)
      if (!fetch) throw new Error(`missing test binding for ${identity.directory}`)
      expect(fetch).toHaveBeenCalledTimes(1)
      const call = fetch.mock.calls[0]
      if (!call) throw new Error(`missing request for ${identity.directory}`)
      const [input, init] = call
      const request = new Request(input, init)
      expect(request.headers.get('x-internal-key')).toBe(`${identity.directory}-key`)
    }
  })

  it.each(['parallel', 'sequential'] as const)(
    'runs the same %s orchestration across three computed tuples and continues after the first failure',
    async (concurrency) => {
      const identities = [
        { directory: 'booking', binding: 'BOOKING', secret: 'ADMIN_TO_BOOKING_KEY' },
        { directory: 'inventory', binding: 'INVENTORY', secret: 'ADMIN_TO_INVENTORY_KEY' },
        { directory: 'shipping', binding: 'SHIPPING', secret: 'ADMIN_TO_SHIPPING_KEY' },
      ]
      const environment = Object.fromEntries(
        identities.flatMap((identity) => [
          [identity.binding, { fetch: vi.fn() }],
          [identity.secret, `${identity.directory}-key`],
        ]),
      )
      const calls: Array<{ directory: string; binding: unknown; key: string }> = []
      const failures: string[] = []

      const successful = await orchestrateDomainSyncIdentities(
        environment,
        identities,
        async (target) => {
          calls.push(target)
          if (target.directory === 'booking') throw new Error('booking unavailable')
          return true
        },
        {
          concurrency,
          onFailure(identity) {
            failures.push(identity.directory)
          },
        },
      )

      expect(successful).toBe(false)
      expect(calls.map(({ directory }) => directory)).toEqual(['booking', 'inventory', 'shipping'])
      expect(calls.map(({ binding }) => binding)).toEqual(
        identities.map((identity) => environment[identity.binding]),
      )
      expect(calls.map(({ key }) => key)).toEqual(['booking-key', 'inventory-key', 'shipping-key'])
      expect(failures).toEqual(['booking'])
    },
  )

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
    const booking = binding(Response.json(org)).fetch
    const inventory = binding(Response.json(org)).fetch
    const targets = configuredDomainSyncEnvironments({
      ADMIN_DOMAIN_IDENTITIES: JSON.stringify([
        {
          directory: 'booking',
          binding: 'BOOKING',
          secret: 'ADMIN_TO_BOOKING_KEY',
        },
        {
          directory: 'inventory',
          binding: 'INVENTORY',
          secret: 'ADMIN_TO_INVENTORY_KEY',
        },
      ]),
      BOOKING: { fetch: booking },
      INVENTORY: { fetch: inventory },
      ADMIN_TO_BOOKING_KEY: 'booking-key',
      ADMIN_TO_INVENTORY_KEY: 'inventory-key',
    })
    expect(targets).toEqual([
      {
        directory: 'booking',
        binding: { fetch: booking },
        key: 'booking-key',
      },
      {
        directory: 'inventory',
        binding: { fetch: inventory },
        key: 'inventory-key',
      },
    ])
  })

  it('executes the exported pure resolver with computed binding and secret access for multiple tuples', () => {
    const booking = binding(Response.json(org)).fetch
    const inventory = binding(Response.json(org)).fetch
    const environment = {
      BOOKING: { fetch: booking },
      INVENTORY: { fetch: inventory },
      ADMIN_TO_BOOKING_KEY: 'booking-key',
      ADMIN_TO_INVENTORY_KEY: 'inventory-key',
    }

    expect(
      [
        { directory: 'booking', binding: 'BOOKING', secret: 'ADMIN_TO_BOOKING_KEY' },
        { directory: 'inventory', binding: 'INVENTORY', secret: 'ADMIN_TO_INVENTORY_KEY' },
      ].map((identity) => resolveDomainSyncIdentity(environment, identity)),
    ).toEqual([
      { directory: 'booking', binding: { fetch: booking }, key: 'booking-key' },
      { directory: 'inventory', binding: { fetch: inventory }, key: 'inventory-key' },
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
