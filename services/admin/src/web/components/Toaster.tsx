import { cn } from '@app/ui'
import { type Toast, type ToastTone, toast, useToasts } from '../store/toast'

/**
 * トーストの表示点。画面下(モバイル中央 / md 以上は右下)に固定で積む。
 * 色は @app/ui theme.css のトークンのみ。danger は role="alert"。
 */

const TONE: Record<ToastTone, string> = {
  success: 'bg-pine/10 text-pine',
  danger: 'bg-danger/10 text-danger',
  info: 'border border-line bg-surface text-ink',
}

const DOT: Record<ToastTone, string> = {
  success: 'bg-pine',
  danger: 'bg-danger',
  info: 'bg-ink-muted',
}

export function Toaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-6 md:items-end md:px-6">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastItem({ toast: t }: { toast: Toast }) {
  return (
    <div
      role={t.tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-ctl border border-line px-4 py-3',
        'font-sans text-sm leading-relaxed',
        TONE[t.tone],
      )}
    >
      <span
        aria-hidden="true"
        className={cn('mt-1.5 size-1.5 flex-none rounded-full', DOT[t.tone])}
      />
      <span className="min-w-0 flex-1">{t.message}</span>
      <button
        type="button"
        onClick={() => toast.dismiss(t.id)}
        aria-label="閉じる"
        className="-mr-1 -mt-0.5 inline-flex size-6 flex-none items-center justify-center rounded-ctl font-mono text-base text-current opacity-70 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
      >
        ×
      </button>
    </div>
  )
}
