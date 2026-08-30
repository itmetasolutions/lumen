import 'server-only'
import { env } from '@/server/env'
import { assertPublicUrl, BlockedUrlError } from './ssrf'

/**
 * Safe fetch for arbitrary third-party websites (§12, §29).
 *
 * Redirects are followed *manually* so that every hop can be re-validated by the
 * SSRF guard — `redirect: 'follow'` would let a public URL bounce us to
 * 127.0.0.1 without another check. Responses are size-capped and content-type
 * checked so a 4 GB video download cannot take out an audit worker.
 */

const MAX_REDIRECTS = 5
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB is generous for an HTML document
const DEFAULT_TIMEOUT_MS = 20_000

const HTML_TYPES = ['text/html', 'application/xhtml+xml']

export interface FetchedPage {
  url: string
  finalUrl: string
  status: number
  ok: boolean
  redirectChain: string[]
  contentType: string | null
  body: string
  bytes: number
  loadMs: number
  headers: Record<string, string>
  truncated: boolean
}

export interface FetchOptions {
  timeoutMs?: number
  /** HEAD-style check: stop after headers. Used for broken-link checking. */
  method?: 'GET' | 'HEAD'
  acceptTypes?: string[]
  maxBytes?: number
}

export class FetchFailure extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
    readonly kind:
      | 'blocked'
      | 'timeout'
      | 'dns'
      | 'network'
      | 'too-many-redirects'
      | 'content-type'
      | 'too-large',
  ) {
    super(reason)
    this.name = 'FetchFailure'
  }
}

function userAgent(): string {
  return env.crawlerContact
    ? `${env.crawlerUserAgent} contact=${env.crawlerContact}`
    : env.crawlerUserAgent
}

export async function safeFetch(
  rawUrl: string,
  options: FetchOptions = {},
): Promise<FetchedPage> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    method = 'GET',
    acceptTypes = HTML_TYPES,
    maxBytes = MAX_BYTES,
  } = options

  const started = Date.now()
  const redirectChain: string[] = []
  let current = rawUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Re-validated on every hop. This is the point of the manual loop.
    try {
      await assertPublicUrl(current)
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        throw new FetchFailure(current, err.reason, 'blocked')
      }
      throw err
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    try {
      res = await fetch(current, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent(),
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-GB,en;q=0.9',
        },
      })
    } catch (err) {
      clearTimeout(timer)
      const message = (err as Error).message ?? String(err)
      const kind = controller.signal.aborted
        ? 'timeout'
        : /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(message)
          ? 'dns'
          : 'network'
      throw new FetchFailure(
        current,
        kind === 'timeout' ? `timed out after ${timeoutMs}ms` : message,
        kind,
      )
    } finally {
      clearTimeout(timer)
    }

    // ── Redirect?
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) {
        // A redirect with no target is a dead end, not an error to retry.
        return finish(res, current, '', 0, redirectChain, started, false)
      }
      let next: string
      try {
        next = new URL(location, current).toString()
      } catch {
        throw new FetchFailure(current, `invalid redirect target "${location}"`, 'network')
      }
      redirectChain.push(current)
      current = next
      // Drain so the socket can be reused.
      await res.body?.cancel().catch(() => {})
      continue
    }

    const contentType = res.headers.get('content-type')

    if (method === 'HEAD') {
      return finish(res, current, '', 0, redirectChain, started, false)
    }

    if (contentType && acceptTypes.length > 0) {
      const base = contentType.split(';')[0]!.trim().toLowerCase()
      if (!acceptTypes.some((t) => base === t)) {
        await res.body?.cancel().catch(() => {})
        throw new FetchFailure(
          current,
          `unsupported content-type "${base}"`,
          'content-type',
        )
      }
    }

    // Bounded read — never trust content-length, stream and count.
    const { text, bytes, truncated } = await readCapped(res, maxBytes)
    return finish(res, current, text, bytes, redirectChain, started, truncated)
  }

  throw new FetchFailure(rawUrl, `more than ${MAX_REDIRECTS} redirects`, 'too-many-redirects')
}

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text()
    return { text, bytes: Buffer.byteLength(text), truncated: false }
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))))
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  return { text: buf.toString('utf8'), bytes: buf.byteLength, truncated }
}

function finish(
  res: Response,
  finalUrl: string,
  body: string,
  bytes: number,
  redirectChain: string[],
  started: number,
  truncated: boolean,
): FetchedPage {
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  return {
    url: redirectChain[0] ?? finalUrl,
    finalUrl,
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    redirectChain,
    contentType: res.headers.get('content-type'),
    body,
    bytes,
    loadMs: Date.now() - started,
    headers,
    truncated,
  }
}

/** Lightweight reachability probe used for broken-link checking. */
export async function checkLink(
  url: string,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number | null; reason: string | null }> {
  try {
    const head = await safeFetch(url, { method: 'HEAD', timeoutMs, acceptTypes: [] })
    // Some servers reject HEAD but serve GET correctly — verify before reporting.
    if (head.status === 405 || head.status === 501) {
      const get = await safeFetch(url, { timeoutMs, acceptTypes: [] })
      return { ok: get.ok, status: get.status, reason: get.ok ? null : `HTTP ${get.status}` }
    }
    return {
      ok: head.ok,
      status: head.status,
      reason: head.ok ? null : `HTTP ${head.status}`,
    }
  } catch (err) {
    if (err instanceof FetchFailure) {
      return { ok: false, status: null, reason: err.reason }
    }
    return { ok: false, status: null, reason: (err as Error).message }
  }
}
