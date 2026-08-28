import { describe, expect, it } from 'vitest'
import { checkR2BucketPrivate } from '../src/r2-policy'

const account = 'a'.repeat(32)

describe('checkR2BucketPrivate', () => {
  it('requires Cloudflare REST responses to report success=true', async () => {
    await expect(
      checkR2BucketPrivate(
        account,
        'private-backups',
        'token',
        async () => new Response(JSON.stringify({ success: false, result: { enabled: false } })),
      ),
    ).rejects.toThrow('r2_policy_api_unsuccessful')
  })

  it('accepts a successful private managed and custom-domain response', async () => {
    await expect(
      checkR2BucketPrivate(account, 'private-backups', 'token', async (input) => {
        const url = String(input)
        return url.endsWith('/managed')
          ? new Response(JSON.stringify({ success: true, result: { enabled: false } }))
          : new Response(JSON.stringify({ success: true, result: { domains: [] } }))
      }),
    ).resolves.toBe(true)
  })
})
