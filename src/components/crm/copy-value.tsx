'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Phone } from 'lucide-react'
import { cn, NOT_FOUND } from '@/lib/utils'

/**
 * Click-to-copy.
 *
 * An agent on a call copies the same number dozens of times a shift, so this is
 * one click with no menu and no dialog — the value itself is the button. The
 * confirmation replaces the icon in place rather than raising a toast, because
 * a toast would cover the next row in the queue.
 *
 * `navigator.clipboard` needs a secure context; the desktop build and localhost
 * both qualify, but a plain-HTTP deployment does not, so there is a fallback
 * that still works there rather than a button that silently does nothing.
 */

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied or insecure context — fall through.
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

export function useCopy(resetMs = 1400) {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = useCallback(
    async (value: string) => {
      const ok = await writeClipboard(value)
      if (!ok) return false
      setCopied(value)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(null), resetMs)
      return true
    },
    [resetMs],
  )

  return { copied, copy }
}

export function CopyValue({
  value,
  label,
  className,
  mono = false,
}: {
  value: string | null | undefined
  /** Shown instead of the raw value; the value is still what gets copied. */
  label?: string
  className?: string
  mono?: boolean
}) {
  const { copied, copy } = useCopy()

  if (!value) return <span className={cn('text-subtle', className)}>{NOT_FOUND}</span>

  const done = copied === value

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void copy(value)
      }}
      title={done ? 'Copied' : `Copy "${value}"`}
      aria-label={done ? 'Copied to clipboard' : `Copy ${value}`}
      className={cn(
        'group inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 -mx-1',
        'text-left transition-colors hover:bg-surface-2',
        className,
      )}
    >
      <span className={cn('truncate', mono && 'tnum')}>{label ?? value}</span>
      {done ? (
        <Check className="h-3 w-3 shrink-0 text-ok" aria-hidden="true" />
      ) : (
        <Copy
          className="h-3 w-3 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden="true"
        />
      )}
    </button>
  )
}

/**
 * A phone number an agent is about to dial.
 *
 * Larger and copy-first: the number is what gets used, and on a desktop softphone
 * that means the clipboard. The `tel:` link sits beside it rather than wrapping
 * the number, so a mis-click dials nothing.
 */
export function PhoneValue({
  phone,
  size = 'md',
  showDial = true,
  className,
}: {
  phone: string | null | undefined
  size?: 'sm' | 'md' | 'lg'
  showDial?: boolean
  className?: string
}) {
  const { copied, copy } = useCopy()

  if (!phone) {
    return <span className={cn('text-subtle', className)}>{NOT_FOUND}</span>
  }

  const done = copied === phone
  const sizes = {
    sm: 'text-[13px]',
    md: 'text-sm',
    lg: 'text-lg font-semibold',
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void copy(phone)
        }}
        title={done ? 'Copied' : 'Click to copy'}
        aria-label={done ? 'Phone number copied' : `Copy phone number ${phone}`}
        className={cn(
          'group inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -mx-1.5',
          'tnum transition-colors hover:bg-accent-soft hover:text-accent',
          done && 'text-ok',
          sizes[size],
        )}
      >
        {phone}
        {done ? (
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Copy
            className="h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
      </button>

      {showDial && (
        <a
          href={`tel:${phone.replace(/[^\d+]/g, '')}`}
          onClick={(e) => e.stopPropagation()}
          title="Open in your dialler"
          aria-label="Open in dialler"
          className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Phone className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      )}
    </span>
  )
}
