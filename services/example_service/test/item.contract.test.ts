import { CreateItem } from '@app/contracts'
import { describe, expect, it } from 'vitest'

// Unit test of the shared Zod contract (the single source of truth).
describe('CreateItem contract', () => {
  it('accepts a valid payload and defaults body', () => {
    const parsed = CreateItem.parse({ title: 'ok' })
    expect(parsed).toEqual({ title: 'ok', body: '' })
  })

  it('rejects an empty title', () => {
    expect(CreateItem.safeParse({ title: '' }).success).toBe(false)
  })

  it('rejects a title over 200 chars', () => {
    expect(CreateItem.safeParse({ title: 'a'.repeat(201) }).success).toBe(false)
  })
})
