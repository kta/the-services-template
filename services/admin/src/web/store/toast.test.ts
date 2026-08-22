import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast, useToasts } from './toast'

describe('toast store', () => {
  afterEach(() => {
    toast.clear()
    vi.useRealTimers()
  })

  it('publishes, deduplicates, and dismisses messages through the hook', () => {
    const { result } = renderHook(() => useToasts())
    let id = ''
    act(() => {
      id = toast.success('Saved')
      toast.success('Saved')
      toast.info('Refreshing')
    })

    expect(result.current).toEqual([
      { id, tone: 'success', message: 'Saved' },
      { id: 't2', tone: 'info', message: 'Refreshing' },
    ])

    act(() => toast.dismiss(id))
    expect(result.current).toEqual([{ id: 't2', tone: 'info', message: 'Refreshing' }])
  })

  it('automatically removes a displayed toast after its lifetime', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToasts())
    act(() => {
      toast.error('Failed')
      vi.advanceTimersByTime(6000)
    })
    expect(result.current).toEqual([])
  })
})
