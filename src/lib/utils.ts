import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The product rule from §1: never guess. Anything the pipeline did not actually
 * collect renders as "Not Found" — not an empty cell, not a plausible default.
 */
export const NOT_FOUND = 'Not Found'

export function display(value: unknown): string {
  if (value === null || value === undefined) return NOT_FOUND
  if (typeof value === 'string' && value.trim() === '') return NOT_FOUND
  if (Array.isArray(value) && value.length === 0) return NOT_FOUND
  return String(value)
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return NOT_FOUND
  return new Intl.NumberFormat('en-US').format(n)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return NOT_FOUND
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return NOT_FOUND
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return NOT_FOUND
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return NOT_FOUND
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return NOT_FOUND
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return NOT_FOUND
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** §32 — audit freshness, expressed the way a salesperson reads it. */
export function freshness(d: Date | string | null | undefined): string {
  if (!d) return 'Never'
  const date = typeof d === 'string' ? new Date(d) : d
  const diff = Date.now() - date.getTime()
  if (diff < 0) return 'Just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  return `${Math.floor(months / 12)} year(s) ago`
}

export function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, n))
}

export function pct(part: number, total: number): number {
  if (!total) return 0
  return Math.round((part / total) * 100)
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
