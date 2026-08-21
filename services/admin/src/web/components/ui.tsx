import { cn } from '@app/ui'
import type { ReactNode } from 'react'

/**
 * admin SPA ローカルの共通 UI。@app/ui theme.css のセマンティックトークンだけを
 * 参照する(Tailwind 既定パレット / 任意値は使わない)。共有プリミティブ
 * (Button/TextInput/Notice/Chip/Dialog/Select/Textarea)は @app/ui のものを使い、
 * ここはページ骨格(PageHeader/Section/EmptyState/Spinner)のみ。
 */

/** ページ見出し(タイトル + 補助 + 右側アクション)。 */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string
  sub?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {sub && <p className="mt-1 font-sans text-sm text-ink-muted">{sub}</p>}
      </div>
      {actions}
    </div>
  )
}

/** カードセクション。 */
export function Section({
  title,
  sub,
  actions,
  children,
  className,
}: {
  title?: string
  sub?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-ctl border border-line bg-surface p-6', className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="font-sans text-lg font-semibold text-ink">{title}</h2>}
            {sub && <p className="mt-0.5 font-sans text-sm text-ink-muted">{sub}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className={cn(title || actions ? 'mt-4' : '')}>{children}</div>
    </section>
  )
}

/** 空状態。 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-ctl border border-line bg-surface px-6 py-10 text-center font-display text-lg text-ink-muted italic">
      {children}
    </p>
  )
}

/** 読み込み中スピナー(装飾のみ)。 */
export function Spinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-6" aria-live="polite">
      <span
        aria-hidden="true"
        className="size-5 animate-spin rounded-full border-2 border-line border-t-pine"
      />
      <span className="font-sans text-sm text-ink-muted">{label}</span>
    </div>
  )
}
