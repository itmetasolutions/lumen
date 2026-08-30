import 'server-only'

/**
 * In-process rate limiter for API routes (§29).
 *
 * Deliberately simple: a fixed-window counter per key held in memory. That is
 * the right trade for a single-node deployment and it degrades safely — a
 * multi-node deployment gets per-node limits rather than none. The queue's own
 * per-provider limiter is what protects external APIs; this one protects us.
 */

interface Window {
  count: number
  resetAt: number
}

const buckets = new Map<string, Window>()
let lastSweep = Date.now()

export interface RateLimitResult {
  ok: boolean
  remaining: number
  resetAt: number
  retryAfterSeconds: number
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now()

  // Opportunistic sweep so the map cannot grow without bound.
  if (now - lastSweep > 60_000) {
    for (const [k, w] of buckets) if (w.resetAt < now) buckets.delete(k)
    lastSweep = now
  }

  const existing = buckets.get(key)
  if (!existing || existing.resetAt < now) {
    const window: Window = { count: 1, resetAt: now + windowMs }
    buckets.set(key, window)
    return {
      ok: true,
      remaining: limit - 1,
      resetAt: window.resetAt,
      retryAfterSeconds: 0,
    }
  }

  existing.count++
  const ok = existing.count <= limit
  return {
    ok,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: ok ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  }
}

export const LIMITS = {
  auth: { limit: 10, windowMs: 60_000 },
  read: { limit: 240, windowMs: 60_000 },
  write: { limit: 60, windowMs: 60_000 },
  expensive: { limit: 12, windowMs: 60_000 },
} as const

export function clientKey(req: Request, suffix: string): string {
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const ip = fwd || req.headers.get('x-real-ip') || 'local'
  return `${ip}:${suffix}`
}
