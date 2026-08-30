import 'server-only'

/**
 * Outbound HTTP for *known* provider APIs (not for crawling arbitrary sites —
 * that goes through crawler/safe-fetch.ts, which adds SSRF protection).
 *
 * Provides the things every provider needs and none should re-implement:
 * timeouts, bounded retry with backoff, and per-host rate limiting (§31, §33).
 */

export interface HttpOptions extends RequestInit {
  timeoutMs?: number
  retries?: number
  /** Retry only on these statuses (plus network errors). */
  retryOn?: number[]
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`)
    this.name = 'HttpError'
  }
}

const DEFAULT_RETRY_ON = [408, 425, 429, 500, 502, 503, 504]

export async function httpRequest(
  url: string,
  options: HttpOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 20_000,
    retries = 2,
    retryOn = DEFAULT_RETRY_ON,
    ...init
  } = options

  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // Honour an externally supplied signal alongside our timeout.
    const external = init.signal
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', () => controller.abort(), { once: true })
    }

    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      clearTimeout(timer)

      if (!res.ok && retryOn.includes(res.status) && attempt < retries) {
        // Respect Retry-After when the provider tells us how long to wait.
        const retryAfter = Number(res.headers.get('retry-after'))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff(attempt)
        await sleep(Math.min(wait, 30_000))
        continue
      }
      return res
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      if (attempt < retries) {
        await sleep(backoff(attempt))
        continue
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request to ${url} failed`)
}

export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const res = await httpRequest(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new HttpError(res.status, url, text)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(res.status, url, `Non-JSON response: ${text.slice(0, 200)}`)
  }
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt * (0.75 + Math.random() * 0.5)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Token-bucket limiter, one bucket per key (usually a provider id).
 * Keeps us inside published rate limits instead of discovering them via 429s.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>()

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst = Math.max(1, Math.ceil(ratePerSecond)),
  ) {}

  async acquire(key: string): Promise<void> {
    for (;;) {
      const now = Date.now()
      const b = this.buckets.get(key) ?? { tokens: this.burst, last: now }
      const elapsed = (now - b.last) / 1000
      b.tokens = Math.min(this.burst, b.tokens + elapsed * this.ratePerSecond)
      b.last = now

      if (b.tokens >= 1) {
        b.tokens -= 1
        this.buckets.set(key, b)
        return
      }
      this.buckets.set(key, b)
      const waitMs = ((1 - b.tokens) / this.ratePerSecond) * 1000
      await sleep(Math.max(20, Math.min(waitMs, 5_000)))
    }
  }
}
