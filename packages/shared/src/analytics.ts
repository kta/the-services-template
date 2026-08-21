// Central event registry — add new events here so names don't drift across PRs.
// snake_case, ≤ 25 chars. Never pass PII (name/email) in params; ids are OK.
export const ANALYTICS_EVENTS = {
  ITEM_CREATED: 'item_created',
  ORGANIZATION_CREATED: 'organization_created',
  LOGIN_SUCCESS: 'login_success',
} as const

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]

type GtagFn = (command: 'event', event: string, params?: Record<string, unknown>) => void

// No-op unless GA4's gtag is present (so dev/test stay safe).
export function trackEvent(
  event: AnalyticsEvent,
  params: Record<string, string | number> = {},
): void {
  const gtag = (globalThis as { gtag?: GtagFn }).gtag
  if (typeof gtag === 'function') gtag('event', event, params)
}
