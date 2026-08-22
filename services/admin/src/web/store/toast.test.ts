import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToastStore, type ToastStore } from './toast'

const stores: ToastStore[] = []

function makeStore(autoDismissMs = 6000): ToastStore {
  const ids = ['toast-1', 'toast-2', 'toast-3']
  const store = createToastStore({
    autoDismissMs,
    idFactory: () => {
      const id = ids.shift()
      if (!id) throw new Error('unexpected toast id request')
      return id
    },
  })
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores) store.clear()
  stores.length = 0
  vi.useRealTimers()
})

describe('toast store', () => {
  it('adds helper toasts in display order', () => {
    const store = makeStore()

    expect(store.success('Saved')).toBe('toast-1')
    expect(store.error('Failed')).toBe('toast-2')
    expect(store.info('Refreshing')).toBe('toast-3')
    expect(store.list()).toEqual([
      { id: 'toast-1', tone: 'success', message: 'Saved' },
      { id: 'toast-2', tone: 'danger', message: 'Failed' },
      { id: 'toast-3', tone: 'info', message: 'Refreshing' },
    ])
  })

  it('suppresses duplicate tone and message pairs', () => {
    const store = makeStore()

    const first = store.success('Saved')
    const duplicate = store.success('Saved')

    expect(duplicate).toBe(first)
    expect(store.list()).toEqual([{ id: 'toast-1', tone: 'success', message: 'Saved' }])
  })

  it('restarts the dismissal timer when a duplicate is shown', () => {
    vi.useFakeTimers()
    const store = makeStore()

    store.success('Saved')
    vi.advanceTimersByTime(5999)
    store.success('Saved')
    vi.advanceTimersByTime(5999)

    expect(store.list()).toEqual([{ id: 'toast-1', tone: 'success', message: 'Saved' }])

    vi.advanceTimersByTime(1)
    expect(store.list()).toEqual([])
  })

  it('dismisses a known toast and ignores an unknown id', () => {
    const store = makeStore()
    const id = store.info('Refreshing')
    let updates = 0
    store.subscribe(() => {
      updates += 1
    })

    store.dismiss('missing')
    store.dismiss(id)

    expect(store.list()).toEqual([])
    expect(updates).toBe(1)
  })

  it('clears all toasts and cancels their pending dismissal', () => {
    vi.useFakeTimers()
    const store = makeStore()
    store.success('Saved')
    store.error('Failed')

    store.clear()
    vi.advanceTimersByTime(6000)

    expect(store.list()).toEqual([])
  })

  it('notifies subscribers until they unsubscribe', () => {
    const store = makeStore()
    const snapshots: number[] = []
    const unsubscribe = store.subscribe(() => {
      snapshots.push(store.list().length)
    })

    const id = store.success('Saved')
    unsubscribe()
    store.dismiss(id)

    expect(snapshots).toEqual([1])
  })

  it('keeps toasts when automatic dismissal is disabled', () => {
    vi.useFakeTimers()
    const store = makeStore(0)
    store.info('Refreshing')

    vi.advanceTimersByTime(60_000)

    expect(store.list()).toEqual([{ id: 'toast-1', tone: 'info', message: 'Refreshing' }])
  })

  it('automatically dismisses a toast after its configured lifetime', () => {
    vi.useFakeTimers()
    const store = makeStore(100)
    store.error('Failed')

    vi.advanceTimersByTime(99)
    expect(store.list()).toEqual([{ id: 'toast-1', tone: 'danger', message: 'Failed' }])

    vi.advanceTimersByTime(1)
    expect(store.list()).toEqual([])
  })
})
