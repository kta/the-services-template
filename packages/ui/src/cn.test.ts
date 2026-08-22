import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('filters absent values and joins the remaining class names in order', () => {
    expect(cn('field', false, null, undefined, 'field--error')).toBe('field field--error')
  })

  it('returns an empty class name when every value is absent', () => {
    expect(cn(false, null, undefined)).toBe('')
  })
})
