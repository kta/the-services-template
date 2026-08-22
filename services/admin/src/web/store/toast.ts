import { useSyncExternalStore } from 'react'

/**
 * 軽量トーストストア。操作失敗の理由を日本語で提示する。
 * React 非依存の純ロジック(useSyncExternalStore で購読)。複数トースト・自動消去・
 * 同一文言の重複抑制(dedupe)。`Toaster` が唯一の表示点。
 */

export type ToastTone = 'success' | 'danger' | 'info'

export interface Toast {
  id: string
  tone: ToastTone
  message: string
}

export interface ToastStore {
  list(): readonly Toast[]
  subscribe(cb: () => void): () => void
  show(tone: ToastTone, message: string): string
  success(message: string): string
  error(message: string): string
  info(message: string): string
  dismiss(id: string): void
  clear(): void
}

export interface ToastStoreOptions {
  autoDismissMs?: number
  idFactory?: () => string
}

const DEFAULT_AUTO_DISMISS_MS = 6000

export function createToastStore(options: ToastStoreOptions = {}): ToastStore {
  const autoDismissMs = options.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS
  let seq = 0
  const idFactory =
    options.idFactory ??
    (() => {
      seq += 1
      return `t${seq}`
    })

  let items: Toast[] = []
  const listeners = new Set<() => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function emit(): void {
    for (const l of listeners) l()
  }

  function scheduleDismiss(id: string): void {
    if (autoDismissMs <= 0) return
    timers.set(
      id,
      setTimeout(() => dismiss(id), autoDismissMs),
    )
  }

  function clearTimer(id: string): void {
    const t = timers.get(id)
    if (t) {
      clearTimeout(t)
      timers.delete(id)
    }
  }

  function dismiss(id: string): void {
    const next = items.filter((it) => it.id !== id)
    clearTimer(id)
    if (next.length === items.length) return
    items = next
    emit()
  }

  function show(tone: ToastTone, message: string): string {
    const existing = items.find((it) => it.tone === tone && it.message === message)
    if (existing) {
      clearTimer(existing.id)
      scheduleDismiss(existing.id)
      return existing.id
    }
    const id = idFactory()
    items = [...items, { id, tone, message }]
    scheduleDismiss(id)
    emit()
    return id
  }

  return {
    list: () => items,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    show,
    success: (message) => show('success', message),
    error: (message) => show('danger', message),
    info: (message) => show('info', message),
    dismiss,
    clear() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      if (items.length === 0) return
      items = []
      emit()
    },
  }
}

export const toast = createToastStore()

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(toast.subscribe, toast.list, toast.list)
}
