import 'server-only'
import * as cheerio from 'cheerio'
import { env } from '@/server/env'
import { normalizeUrl, resolveUrl, sameSite } from '@/server/normalize/url'
import { safeFetch, FetchFailure, type FetchedPage } from './fetch'
import { fetchRobots, isAllowed, type RobotsRules } from './robots'

/**
 * The site crawler (§12).
 *
 * Explicitly *not* a general web spider. For a first audit it visits the
 * homepage plus the handful of pages that actually carry audit signal — contact,
 * about, services — because crawling 200 pages of a blog tells you nothing extra
 * about whether the site needs a redesign, and costs 200× as much.
 *
 * Guarantees: bounded page count, bounded time, per-host politeness delay,
 * duplicate-URL suppression, robots compliance, and — critically — a single
 * broken page never aborts the crawl (§12, §31).
 */

export type PageRole = 'home' | 'contact' | 'about' | 'services' | 'other'

export interface CrawledDoc {
  url: string
  normalizedUrl: string
  finalUrl: string
  role: PageRole
  status: number | null
  redirectChain: string[]
  contentType: string | null
  bytes: number
  loadMs: number
  html: string
  title: string | null
  /** Lower-cased response headers, used for technology and server detection. */
  headers: Record<string, string>
  error: string | null
  errorKind: string | null
}

export interface CrawlResult {
  origin: string
  robots: RobotsRules
  pages: CrawledDoc[]
  /** Links discovered but not fetched — used for broken-link sampling. */
  discoveredLinks: string[]
  blockedByRobots: string[]
  homeReachable: boolean
  fatalError: string | null
}

export interface CrawlOptions {
  maxPages: number
  timeoutMsPerPage?: number
  /** Politeness gap between requests to the same host. */
  delayMs?: number
  totalBudgetMs?: number
}

/** Scored hints for which internal links are worth fetching. */
const ROLE_HINTS: Array<{ role: PageRole; patterns: RegExp[]; weight: number }> = [
  {
    role: 'contact',
    patterns: [/\bcontact\b/i, /\bget-?in-?touch\b/i, /\bfind-?us\b/i, /\benquir/i],
    weight: 100,
  },
  {
    role: 'services',
    patterns: [/\bservices?\b/i, /\btreatments?\b/i, /\bproducts?\b/i, /\bwhat-?we-?do\b/i, /\bpricing\b/i],
    weight: 80,
  },
  {
    role: 'about',
    patterns: [/\babout\b/i, /\bour-?story\b/i, /\bteam\b/i, /\bwho-?we-?are\b/i],
    weight: 60,
  },
]

/** Never worth an audit request. */
const SKIP_PATTERNS = [
  /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|css|js|mp4|webm|mp3|zip|rar|docx?|xlsx?|pptx?)($|\?)/i,
  /\/wp-(admin|login|json)\b/i,
  /\/(cart|checkout|basket|account|login|signin|register|logout)\b/i,
  /[?&](add-to-cart|replytocom)=/i,
  /\/feed\/?$/i,
  /#/,
]

function classifyRole(url: string): { role: PageRole; weight: number } {
  const path = (() => {
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  })()
  if (path === '/' || path === '') return { role: 'home', weight: 1000 }
  for (const hint of ROLE_HINTS) {
    if (hint.patterns.some((p) => p.test(path))) {
      return { role: hint.role, weight: hint.weight }
    }
  }
  // Shallow pages are likelier to be primary navigation than deep ones.
  const depth = path.split('/').filter(Boolean).length
  return { role: 'other', weight: Math.max(1, 30 - depth * 8) }
}

export async function crawlSite(
  startUrl: string,
  options: CrawlOptions,
): Promise<CrawlResult> {
  const {
    maxPages,
    timeoutMsPerPage = 20_000,
    delayMs = 700,
    totalBudgetMs = 120_000,
  } = options

  const normalized = normalizeUrl(startUrl)
  if (!normalized) {
    return {
      origin: startUrl,
      robots: { found: false, url: '', groups: [], sitemaps: [], crawlDelaySeconds: null, raw: null },
      pages: [],
      discoveredLinks: [],
      blockedByRobots: [],
      homeReachable: false,
      fatalError: `"${startUrl}" is not a usable URL`,
    }
  }

  const deadline = Date.now() + totalBudgetMs
  const robots = await fetchRobots(normalized.origin, env.crawlerUserAgent)
  const politeDelay = Math.max(
    delayMs,
    Math.min((robots.crawlDelaySeconds ?? 0) * 1000, 5_000),
  )

  const pages: CrawledDoc[] = []
  const visited = new Set<string>()
  const blockedByRobots: string[] = []
  const discovered = new Map<string, number>() // url → weight
  let fatalError: string | null = null

  // Seed with the homepage. If it is unreachable there is nothing to audit,
  // but we still return the failure as data rather than throwing.
  const queue: Array<{ url: string; role: PageRole; weight: number }> = [
    { url: normalized.href, role: 'home', weight: 1000 },
  ]

  while (queue.length > 0 && pages.length < maxPages) {
    if (Date.now() > deadline) {
      fatalError = fatalError ?? 'crawl time budget exhausted'
      break
    }

    queue.sort((a, b) => b.weight - a.weight)
    const next = queue.shift()!
    const key = normalizeUrl(next.url)?.href ?? next.url
    if (visited.has(key)) continue
    visited.add(key)

    let pathname = '/'
    try {
      pathname = new URL(next.url).pathname
    } catch {
      continue
    }

    if (!isAllowed(robots, pathname)) {
      blockedByRobots.push(next.url)
      continue
    }

    if (pages.length > 0) await sleep(politeDelay)

    const doc = await fetchDoc(next.url, key, next.role, timeoutMsPerPage)
    pages.push(doc)

    if (doc.role === 'home' && (doc.error || !doc.status || doc.status >= 400)) {
      // Homepage failed — no point walking a site we cannot read.
      break
    }

    if (!doc.html) continue

    // Harvest internal links for the remaining budget.
    const $ = cheerio.load(doc.html)
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (!href) return
      const abs = resolveUrl(doc.finalUrl, href)
      if (!abs) return
      if (SKIP_PATTERNS.some((p) => p.test(abs))) return
      if (!sameSite(abs, normalized.href)) {
        discovered.set(abs, -1) // external — recorded, never queued
        return
      }
      const n = normalizeUrl(abs)
      if (!n || visited.has(n.href)) return
      const { role, weight } = classifyRole(n.href)
      if (role === 'home') return
      if (!discovered.has(n.href)) discovered.set(n.href, weight)
      if (queue.length + pages.length < maxPages * 3) {
        queue.push({ url: n.href, role, weight })
      }
    })
  }

  return {
    origin: normalized.origin,
    robots,
    pages,
    discoveredLinks: Array.from(discovered.keys()),
    blockedByRobots,
    homeReachable: pages.some((p) => p.role === 'home' && p.status !== null && p.status < 400),
    fatalError,
  }
}

async function fetchDoc(
  url: string,
  normalizedUrl: string,
  role: PageRole,
  timeoutMs: number,
): Promise<CrawledDoc> {
  const base: CrawledDoc = {
    url,
    normalizedUrl,
    finalUrl: url,
    role,
    status: null,
    redirectChain: [],
    contentType: null,
    bytes: 0,
    loadMs: 0,
    html: '',
    title: null,
    headers: {},
    error: null,
    errorKind: null,
  }

  try {
    const res: FetchedPage = await safeFetch(url, { timeoutMs })
    const title = extractTitle(res.body)
    return {
      ...base,
      finalUrl: res.finalUrl,
      status: res.status,
      redirectChain: res.redirectChain,
      contentType: res.contentType,
      bytes: res.bytes,
      loadMs: res.loadMs,
      html: res.body,
      title,
      headers: res.headers,
    }
  } catch (err) {
    if (err instanceof FetchFailure) {
      return { ...base, error: err.reason, errorKind: err.kind }
    }
    return { ...base, error: (err as Error).message, errorKind: 'network' }
  }
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return null
  const text = m[1]!.replace(/\s+/g, ' ').trim()
  return text || null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function maxPagesForDepth(depth: 'QUICK' | 'STANDARD' | 'DEEP'): number {
  switch (depth) {
    case 'QUICK':
      return env.maxPagesQuick
    case 'STANDARD':
      return env.maxPagesStandard
    case 'DEEP':
      return env.maxPagesDeep
  }
}
