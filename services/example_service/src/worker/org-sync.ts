/**
 * Time and revision fences for the admin-to-domain organization mirror.
 * Keep these helpers outside the Worker entry module: Cloudflare's Worker
 * runtime treats every runtime export from the entry module as a handler.
 */
export const ORG_SYNC_MAX_AGE_SECONDS = 2 * 60 * 60

export function isFreshOrgSync(syncedAt: string | null | undefined, nowMs = Date.now()): boolean {
  const syncedMs = typeof syncedAt === 'string' ? Date.parse(syncedAt) : Number.NaN
  return (
    Number.isFinite(nowMs) &&
    Number.isFinite(syncedMs) &&
    syncedMs <= nowMs &&
    nowMs - syncedMs <= ORG_SYNC_MAX_AGE_SECONDS * 1000
  )
}

/**
 * Reject an older admin source revision. `undefined`/`null` means a legacy
 * mirror row; the first complete sync is allowed to establish its fence.
 */
export function isAcceptedOrgSyncVersion(
  incoming: unknown,
  current: number | null | undefined,
): boolean {
  if (!Number.isSafeInteger(incoming) || (incoming as number) <= 0) return false
  if (current === null || current === undefined) return true
  return Number.isSafeInteger(current) && current > 0 && (incoming as number) >= current
}
