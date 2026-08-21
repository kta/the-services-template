import {
  type ButtonHTMLAttributes,
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from './cn'

/*
 * Shared primitives. Deliberately few: one strong button, a handful of form
 * controls, one field wrapper, one card, one notice, one status chip. They
 * only reference semantic tokens from theme.css (bg-pine, text-ink,
 * border-line…), so re-theming a project never touches this file. Layout
 * (stacks, grids, shells) belongs in app code with plain Tailwind — don't
 * wrap it here.
 */

/** Shared focus treatment — amber is spent ONLY here (see theme.css). */
export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber'

// All interactive controls meet the 44px touch-target floor.
const controlBase = 'min-h-11 rounded-ctl font-sans text-sm'

export type ButtonVariant = 'primary' | 'ghost' | 'danger'

/**
 * ボタンのクラス単一ソース(atom)。`<button>` は `Button`、`<a>`/react-router の
 * `Link` はこの関数を className に渡して**同一の見た目**を共有する(二重定義を防ぐ)。
 */
export function buttonClass(variant: ButtonVariant = 'primary', className?: string): string {
  return cn(
    controlBase,
    'inline-flex items-center justify-center gap-2 px-4 py-2 font-medium transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-50',
    focusRing,
    variant === 'primary' && 'bg-pine text-paper hover:bg-pine-deep',
    variant === 'ghost' && 'text-pine hover:bg-pine/10',
    variant === 'danger' && 'border border-line bg-surface text-danger hover:bg-danger/5',
    className,
  )
}

export function Button({
  variant = 'primary',
  type = 'button',
  className,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  ref?: Ref<HTMLButtonElement>
}) {
  return <button ref={ref} type={type} className={buttonClass(variant, className)} {...props} />
}

export function TextInput({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        controlBase,
        'w-full border border-line bg-surface px-3 py-2 text-ink',
        'placeholder:text-ink-muted/70',
        focusRing,
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={cn(
        controlBase,
        'w-full border border-line bg-surface px-3 py-2 text-ink',
        'placeholder:text-ink-muted/70',
        focusRing,
        className,
      )}
      {...props}
    />
  )
}

export function Select({
  className,
  children,
  ref,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <select
      ref={ref}
      className={cn(
        controlBase,
        'w-full border border-line bg-surface px-3 py-2 text-ink',
        focusRing,
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
}

/** Label + control + optional error, wired for accessibility. */
export function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string
  htmlFor: string
  error?: string | null
  children: ReactNode
}) {
  const errorId = `${htmlFor}-error`
  // エラー時はコントロール自身に aria-invalid / aria-describedby を配線する。
  // role="alert" の兄弟要素だけだと、後からフィールドへフォーカスを戻した
  // スクリーンリーダー利用者に「どの入力のエラーか」が伝わらない。
  const control =
    error && isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          'aria-invalid': true,
          'aria-describedby': errorId,
        })
      : children
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="font-sans text-sm font-medium text-ink">
        {label}
      </label>
      {control}
      {error && (
        <p id={errorId} role="alert" className="font-sans text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-ctl border border-line bg-surface p-5', className)}>{children}</div>
  )
}

/**
 * Soft status chip: pill shape, soft fill, strong-color text and a 6px
 * leading dot. Tones are semantic — `success` for good/done/saved, `warning`
 * for attention-needed, `danger` for errors/destructive states, `neutral`
 * for everything else.
 */
export function Chip({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'success' | 'warning' | 'danger' | 'neutral'
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-sans text-xs font-medium',
        tone === 'success' && 'bg-pine/10 text-pine',
        tone === 'warning' && 'bg-amber/15 text-amber-deep',
        tone === 'danger' && 'bg-danger/10 text-danger',
        tone === 'neutral' && 'bg-line/60 text-ink-muted',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          tone === 'success' && 'bg-pine',
          tone === 'warning' && 'bg-amber-deep',
          tone === 'danger' && 'bg-danger',
          tone === 'neutral' && 'bg-ink-muted',
        )}
      />
      {children}
    </span>
  )
}

/** Inline status message for API-level failures (not per-field errors). */
export function Notice({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'info' | 'success'
  children: ReactNode
}) {
  return (
    <p
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-ctl border px-3 py-2 font-sans text-sm',
        tone === 'danger' && 'border-danger/30 bg-danger/5 text-danger',
        tone === 'info' && 'border-line bg-surface text-ink-muted',
        tone === 'success' && 'border-pine/30 bg-pine/5 text-pine',
      )}
    >
      {children}
    </p>
  )
}
