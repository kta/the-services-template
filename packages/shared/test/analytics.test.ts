import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANALYTICS_EVENTS, trackEvent } from '../src/analytics'

type G = { gtag?: (...args: unknown[]) => void }

afterEach(() => {
  delete (globalThis as G).gtag
  vi.restoreAllMocks()
})

describe('trackEvent', () => {
  it('gtag が無ければ no-op(dev/test で安全)', () => {
    expect(() => trackEvent(ANALYTICS_EVENTS.ITEM_CREATED)).not.toThrow()
  })

  it('gtag があれば event として転送する', () => {
    const gtag = vi.fn()
    ;(globalThis as G).gtag = gtag
    trackEvent(ANALYTICS_EVENTS.LOGIN_SUCCESS, { count: 1 })
    expect(gtag).toHaveBeenCalledWith('event', 'login_success', { count: 1 })
  })
})
