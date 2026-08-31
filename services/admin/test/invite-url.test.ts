import { describe, expect, it } from 'vitest'
import { inviteBaseUrl } from '../src/worker/index'

describe('production invite base URL', () => {
  const request = 'https://admin.example.com/api/organizations/org/invitations'

  it('accepts the configured public origin when it matches the request origin', () => {
    expect(
      inviteBaseUrl({
        env: { APP_ENV: 'production', INVITE_BASE_URL: 'https://admin.example.com' },
        req: { url: request },
      }),
    ).toBe('https://admin.example.com')
  })

  it('rejects a production configured origin that differs from the request origin', () => {
    expect(
      inviteBaseUrl({
        env: { APP_ENV: 'production', INVITE_BASE_URL: 'https://attacker.example' },
        req: { url: request },
      }),
    ).toBeNull()
  })

  it('does not invent a production origin when the setting is missing', () => {
    expect(
      inviteBaseUrl({
        env: { APP_ENV: 'production' },
        req: { url: request },
      }),
    ).toBeNull()
  })
})
