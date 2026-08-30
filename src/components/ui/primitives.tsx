'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * UI primitives.
 *
 * Hand-rolled rather than pulled from a component library: the whole product is
 * one dense data surface, and it is easier to keep that coherent with a small
 * set of components we control than to fight a general-purpose kit.
 */

// ── Button ───────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg hover:bg-accent/90 active:bg-accent/95 shadow-sm',
  secondary:
    'bg-surface text-fg border border-border-strong hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white hover:bg-danger/90',
  subtle: 'bg-surface-2 text-fg hover:bg-border',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2',
  icon: 'h-8 w-8 justify-center',
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', loading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center rounded-lg font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-20"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2Z"
      />
    </svg>
  )
}

// ── Input / Select / Textarea ────────────────────────────────────────────────

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm',
      'placeholder:text-subtle',
      'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
      'disabled:cursor-not-allowed disabled:opacity-60',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'h-9 w-full appearance-none rounded-lg border border-border bg-surface px-3 pr-8 text-sm',
      'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
      'bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke-width=\'2\' stroke=\'%2364748b\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' d=\'m19.5 8.25-7.5 7.5-7.5-7.5\'/%3E%3C/svg%3E")]',
      'bg-[length:14px] bg-[right_0.6rem_center] bg-no-repeat',
      className,
    )}
    {...props}
  >
    {children}
  </select>
))
Select.displayName = 'Select'

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm',
      'placeholder:text-subtle',
      'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export function Checkbox({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        'h-4 w-4 shrink-0 cursor-pointer rounded border-border-strong text-accent',
        'focus:ring-2 focus:ring-accent/25 focus:ring-offset-0',
        className,
      )}
      {...props}
    />
  )
}

export function Label({
  className,
  children,
  hint,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { hint?: string }) {
  return (
    <label
      className={cn('mb-1.5 block text-[13px] font-medium text-fg', className)}
      {...props}
    >
      {children}
      {hint && <span className="ml-1.5 font-normal text-subtle">{hint}</span>}
    </label>
  )
}

// ── Badge ────────────────────────────────────────────────────────────────────

type BadgeTone =
  | 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'outline' | 'demo'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent border-accent/25',
  ok: 'bg-ok/10 text-ok border-ok/25',
  warn: 'bg-warn/10 text-warn border-warn/30',
  danger: 'bg-danger/10 text-danger border-danger/25',
  info: 'bg-info/10 text-info border-info/25',
  outline: 'bg-transparent text-muted border-border-strong',
  // Demo data gets a deliberately unmissable treatment (§21).
  demo: 'bg-warn/15 text-warn border-warn/40 font-semibold tracking-wide',
}

export function Badge({
  tone = 'neutral',
  className,
  children,
  title,
}: {
  tone?: BadgeTone
  className?: string
  children: React.ReactNode
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-4',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────

export function Card({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return <div className={cn('panel', className)}>{children}</div>
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-border px-5 py-3.5',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description && (
          <p className="mt-0.5 text-[13px] leading-5 text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-subtle">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-md text-[13px] leading-6 text-muted">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} />
}

export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn('h-3.5', c === 0 ? 'w-56' : 'w-20')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Tooltip (CSS-only, no positioning library) ───────────────────────────────

export function Tooltip({
  label,
  children,
  side = 'top',
  className,
}: {
  label: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom'
  className?: string
}) {
  return (
    <span className={cn('group/tt relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 w-max max-w-xs -translate-x-1/2 rounded-lg',
          'bg-fg px-2.5 py-1.5 text-2xs leading-4 text-bg opacity-0 shadow-pop',
          'transition-opacity duration-100 group-hover/tt:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {label}
      </span>
    </span>
  )
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  width?: string
}) {
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Prevent the page behind the dialog from scrolling with it.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div
        className="fixed inset-0 bg-fg/25 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative z-10 w-full animate-fade-in rounded-xl border border-border bg-surface shadow-pop',
          width,
        )}
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && (
            <p className="mt-1 text-[13px] leading-5 text-muted">{description}</p>
          )}
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Score display ────────────────────────────────────────────────────────────

/**
 * Score bands. `inverted` flips the colour logic for opportunity scores, where
 * a high number is good news for us and bad news for the site.
 */
export function scoreTone(
  score: number | null | undefined,
  inverted = false,
): BadgeTone {
  if (score === null || score === undefined) return 'neutral'
  const s = inverted ? 100 - score : score
  if (s >= 80) return 'ok'
  if (s >= 50) return 'warn'
  return 'danger'
}

export function ScorePill({
  score,
  inverted = false,
  label,
  className,
}: {
  score: number | null | undefined
  inverted?: boolean
  label?: string
  className?: string
}) {
  if (score === null || score === undefined) {
    return <span className={cn('text-2xs text-subtle', className)}>Not Found</span>
  }
  const tone = scoreTone(score, inverted)
  const color =
    tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-danger'

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="relative h-1.5 w-9 overflow-hidden rounded-full bg-surface-2">
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : 'bg-danger',
          )}
          style={{ width: `${Math.max(3, score)}%` }}
        />
      </span>
      <span className={cn('tnum text-[13px] font-semibold', color)}>{score}</span>
      {label && <span className="text-2xs text-subtle">{label}</span>}
    </span>
  )
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone: BadgeTone =
    severity === 'CRITICAL' || severity === 'HIGH'
      ? 'danger'
      : severity === 'MEDIUM'
        ? 'warn'
        : severity === 'LOW'
          ? 'info'
          : 'neutral'
  return <Badge tone={tone}>{severity}</Badge>
}
