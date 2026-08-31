import { describe, expect, it } from 'vitest'
import { JWT_TEST_PRIVATE_KEY, JWT_TEST_PUBLIC_KEY } from '../../../packages/shared/test/jwt-keys'
import {
  BACKUP_SIGNATURE_ALGORITHM,
  canonicalJson,
  signBackupManifest,
  verifyBackupManifest,
} from '../src/lib/manifest-signature'

describe('backup manifest signatures', () => {
  const manifest = {
    targets: {
      admin: { at: '2026-08-27T02:00:00.000Z', bytes: 123, sha256: 'a'.repeat(64) },
    },
    summaries: [{ target: 'admin', ok: true }],
    at: '2026-08-27T02:00:00.000Z',
  }

  it('canonicalizes object key order while preserving array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(canonicalJson([2, 1])).toBe('[2,1]')
  })

  it('signs and verifies the exact unsigned manifest, then rejects tampering', async () => {
    const signature = await signBackupManifest(manifest, JWT_TEST_PRIVATE_KEY)
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await verifyBackupManifest(manifest, signature, JWT_TEST_PUBLIC_KEY)).toBe(true)
    expect(
      await verifyBackupManifest(
        { ...manifest, at: '2026-08-27T02:00:01.000Z' },
        signature,
        JWT_TEST_PUBLIC_KEY,
      ),
    ).toBe(false)
    expect(BACKUP_SIGNATURE_ALGORITHM).toBe('RSASSA-PKCS1-v1_5-SHA256')
  })
})
