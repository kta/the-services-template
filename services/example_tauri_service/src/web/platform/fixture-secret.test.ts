import { describe, expect, it } from 'vitest'
import { validateFixtureSecret } from '../../../e2e/fixture-secret'

describe('E2E fixture secret validation', () => {
  it('accepts a shell-safe disposable token', () => {
    expect(validateFixtureSecret('E2E_FIXTURE_CONTROL_TOKEN', 'a'.repeat(32))).toBe('a'.repeat(32))
  })

  it.each(['short', 'a'.repeat(129), 'safe-token; touch /tmp/pwned', 'safe\nvalue'])(
    'rejects unsafe fixture token %j',
    (value) => {
      expect(() => validateFixtureSecret('E2E_FIXTURE_CONTROL_TOKEN', value)).toThrow()
    },
  )
})
