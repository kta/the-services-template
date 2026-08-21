import { type ReactNode, useEffect, useRef } from 'react'
import { cn } from './cn'

/**
 * Minimal modal dialog on the native <dialog> element, styled like Card.
 * Controlled via `open`; app code builds confirm dialogs etc. on top.
 * Focus trapping / Esc dismiss come from the native element. Backdrop click
 * does NOT dismiss (native <dialog> has no such behavior) — add an explicit
 * close button in app code.
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  children,
  className,
  disableEscape = false,
}: {
  open: boolean
  onClose: () => void
  labelledBy?: string
  children: ReactNode
  className?: string
  /**
   * true で Esc による dismiss を無効化する。「閉じると失われる一度きりの情報」
   * (手動共有用の招待リンク等)を表示している間だけ使い、明示ボタンで閉じさせる。
   */
  disableEscape?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      // Esc は cancel → close の順で両イベントが発火する。onCancel にも onClose を
      // 配ると 1 回の Esc で onClose が 2 度呼ばれるため、close だけを購読する。
      // disableEscape は cancel の既定動作(close)を止めることで実現する。
      onClose={onClose}
      onCancel={disableEscape ? (e) => e.preventDefault() : undefined}
      className={cn(
        'rounded-ctl border border-line bg-surface p-5 backdrop:bg-ink/30',
        'w-full max-w-md text-ink',
        className,
      )}
    >
      {children}
    </dialog>
  )
}
