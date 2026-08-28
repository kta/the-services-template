import { describe, expect, it } from 'vitest'
import {
  isAcceptedOrgSyncVersion,
  isFreshOrgSync,
  ORG_SYNC_MAX_AGE_SECONDS,
} from '../src/worker/org-sync'

const NOW_MS = Date.parse('2026-08-27T00:00:00.000Z')

describe('organization sync lease', () => {
  it.each([
    [0, true],
    [ORG_SYNC_MAX_AGE_SECONDS * 1000, true],
    [ORG_SYNC_MAX_AGE_SECONDS * 1000 + 1, false],
  ])('accepts only a sync received within the lease (%i ms old)', (ageMs, expected) => {
    const syncedAt = new Date(NOW_MS - ageMs).toISOString()
    expect(isFreshOrgSync(syncedAt, NOW_MS)).toBe(expected)
  })

  it.each([
    [null, 'missing'],
    [undefined, 'missing'],
    ['not-a-date', 'invalid'],
    [new Date(NOW_MS + 1).toISOString(), 'future'],
  ])('rejects an unsafe sync timestamp (%s)', (syncedAt, _reason) => {
    expect(isFreshOrgSync(syncedAt, NOW_MS)).toBe(false)
  })

  it.each([
    [1, undefined, true],
    [3, 2, true],
    [3, 3, true],
    [3, 4, false],
    [0, 1, false],
    [1.5, 1, false],
  ])(
    'accepts only a non-decreasing positive sync version (%s, current=%s)',
    (incoming, current, expected) => {
      expect(isAcceptedOrgSyncVersion(incoming, current)).toBe(expected)
    },
  )
})
