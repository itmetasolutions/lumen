import 'server-only'
import * as cheerio from 'cheerio'
import { resolveUrl, normalizeUrl } from '@/server/normalize/url'
import { checkLink } from '@/server/crawler/fetch'
import type { CrawlResult } from '@/server/crawler/crawl'
import type { IssueDraft } from '../types'

/**
 * Technical audit (§10 TECHNICAL, §4 Tab 2).
 *
 * Everything here is observed during or immediately after the crawl: what status
 * a URL returned, how many hops it took, whether the page pulls http:// assets
 * onto an https:// document. No inference.
 */

export interface TechnicalFacts {
  finalStatusCode: number | null
  redirectCount: number
  redirectChain: string[]
  isHttps: boolean
  httpsRedirects: boolean
  mixedContentCount: number
  brokenLinks: number
  checkedLinks: number
  missingAssets: number
  consoleErrors: number
  serverHeader: string | null
  poweredBy: string | null
}

export interface TechnicalOutput {
  facts: TechnicalFacts
  issues: IssueDraft[]
  /** Passed to the SEO stage so broken-link findings are not computed twice. */
  brokenLinkDetails: Array<{ url: string; status: number | null; reason: string | null }>
}

/** How many links to verify. Checking every link on a big site is not free. */
const LINK_SAMPLE = { QUICK: 15, STANDARD: 40, DEEP: 120 } as const
const LINK_CONCURRENCY = 6

export async function runTechnicalAudit(input: {
  crawl: CrawlResult
  depth: 'QUICK' | 'STANDARD' | 'DEEP'
  /** Console errors captured by the UX stage, when it ran. */
  consoleErrors?: number
}): Promise<TechnicalOutput> {
  const { crawl, depth } = input
  const issues: IssueDraft[] = []

  const home = crawl.pages.find((p) => p.role === 'home') ?? crawl.pages[0]

  const isHttps = crawl.origin.startsWith('https://')
  const redirectChain = home?.redirectChain ?? []
  const finalStatusCode = home?.status ?? null

  // ── HTTPS ──────────────────────────────────────────────────────────────────
  const httpsRedirects = redirectChain.some((u) => u.startsWith('http://')) && isHttps

  if (!isHttps) {
    issues.push({
      type: 'technical.https.missing',
      category: 'SECURITY',
      severity: 'CRITICAL',
      confidence: 'HIGH',
      title: 'Site is served over plain HTTP',
      description:
        'The site does not use HTTPS. Browsers mark it "Not secure", any form data travels unencrypted, and search engines treat HTTPS as a ranking signal.',
      evidence: { origin: crawl.origin, scheme: 'http', finalUrl: home?.finalUrl ?? null },
      affectedUrl: home?.finalUrl ?? crawl.origin,
      recommendedAction:
        'Install a TLS certificate and redirect all HTTP traffic to HTTPS with a 301.',
    })
  }

  // ── Redirects ──────────────────────────────────────────────────────────────
  if (redirectChain.length >= 3) {
    issues.push({
      type: 'technical.redirect.chain',
      category: 'TECHNICAL',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `Homepage goes through ${redirectChain.length} redirects`,
      description:
        'Each redirect adds a round trip before anything renders, and long chains lose referrer and link signals.',
      evidence: { chain: [...redirectChain, home?.finalUrl].filter(Boolean), hops: redirectChain.length },
      affectedUrl: home?.finalUrl ?? crawl.origin,
      recommendedAction: 'Point the first URL directly at the final destination.',
    })
  }

  // ── Status codes ───────────────────────────────────────────────────────────
  if (home && home.status !== null && home.status >= 400) {
    issues.push({
      type: 'technical.homepage.error_status',
      category: 'TECHNICAL',
      severity: 'CRITICAL',
      confidence: 'HIGH',
      title: `Homepage returns HTTP ${home.status}`,
      description: 'The homepage does not load successfully for visitors or search engines.',
      evidence: { status: home.status, url: home.finalUrl, redirectChain },
      affectedUrl: home.finalUrl,
      recommendedAction: 'Investigate the server error or restore the missing page.',
    })
  }

  if (home?.error) {
    issues.push({
      type: 'technical.homepage.unreachable',
      category: 'TECHNICAL',
      severity: 'CRITICAL',
      confidence: 'HIGH',
      title: 'Homepage could not be loaded',
      description: `The crawler could not retrieve the homepage: ${home.error}`,
      evidence: { error: home.error, kind: home.errorKind, url: home.url },
      affectedUrl: home.url,
      recommendedAction:
        'Confirm the domain resolves, the server responds, and the certificate is valid.',
    })
  }

  const errorPages = crawl.pages.filter(
    (p) => p.role !== 'home' && p.status !== null && p.status >= 400,
  )
  if (errorPages.length > 0) {
    issues.push({
      type: 'technical.pages.error_status',
      category: 'TECHNICAL',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `${errorPages.length} crawled page(s) returned an error status`,
      description: 'Pages linked from the site’s own navigation do not load.',
      evidence: {
        pages: errorPages.slice(0, 10).map((p) => ({ url: p.finalUrl, status: p.status })),
      },
      affectedUrl: errorPages[0]!.finalUrl,
      recommendedAction: 'Restore or redirect each failing URL.',
    })
  }

  // ── Mixed content & missing assets ─────────────────────────────────────────
  let mixedContentCount = 0
  const mixedExamples: string[] = []
  const assetUrls = new Set<string>()

  for (const page of crawl.pages) {
    if (!page.html) continue
    const $ = cheerio.load(page.html)

    $('img[src], script[src], link[href], iframe[src], video[src], source[src]').each(
      (_, el) => {
        const $el = $(el)
        const raw = $el.attr('src') ?? $el.attr('href')
        if (!raw) return
        // Only stylesheets among <link> elements block rendering / carry assets.
        if (el.tagName === 'link' && !/stylesheet|icon|preload/i.test($el.attr('rel') ?? '')) {
          return
        }
        const abs = resolveUrl(page.finalUrl, raw)
        if (!abs) return

        if (isHttps && abs.startsWith('http://')) {
          mixedContentCount++
          if (mixedExamples.length < 10) mixedExamples.push(abs)
        }
        if (el.tagName === 'img' || el.tagName === 'script') assetUrls.add(abs)
      },
    )
  }

  if (mixedContentCount > 0) {
    issues.push({
      type: 'technical.mixed_content',
      category: 'SECURITY',
      severity: 'HIGH',
      confidence: 'HIGH',
      title: `${mixedContentCount} insecure resource(s) on an HTTPS page`,
      description:
        'The page is served over HTTPS but loads resources over plain HTTP. Browsers block or downgrade these, which can visibly break the page.',
      evidence: { count: mixedContentCount, examples: mixedExamples },
      affectedUrl: home?.finalUrl ?? crawl.origin,
      recommendedAction: 'Update every asset URL to https:// (or protocol-relative).',
    })
  }

  // ── Link checking ──────────────────────────────────────────────────────────
  const sampleSize = LINK_SAMPLE[depth]
  const linksToCheck = pickLinksToCheck(crawl, sampleSize)
  const linkResults = await mapLimit(linksToCheck, LINK_CONCURRENCY, async (url) => {
    const r = await checkLink(url)
    return { url, ...r }
  })

  const brokenLinkDetails = linkResults
    .filter((r) => !r.ok)
    .map((r) => ({ url: r.url, status: r.status, reason: r.reason }))

  const brokenExternal = brokenLinkDetails.filter((b) => {
    const n = normalizeUrl(b.url)
    const o = normalizeUrl(crawl.origin)
    return !(n && o && n.domain === o.domain)
  })

  if (brokenExternal.length > 0) {
    issues.push({
      type: 'technical.links.broken_external',
      category: 'TECHNICAL',
      severity: 'LOW',
      confidence: 'MEDIUM',
      title: `${brokenExternal.length} broken outbound link(s)`,
      description:
        'Links to other sites no longer resolve. Lower confidence than internal links because a remote host may simply be blocking automated checks.',
      evidence: { links: brokenExternal.slice(0, 10) },
      affectedUrl: home?.finalUrl ?? crawl.origin,
      recommendedAction: 'Update or remove the dead outbound links.',
    })
  }

  // ── Missing assets ─────────────────────────────────────────────────────────
  const assetSample = Array.from(assetUrls).slice(0, depth === 'QUICK' ? 8 : 25)
  const assetResults = await mapLimit(assetSample, LINK_CONCURRENCY, async (url) => {
    const r = await checkLink(url, 8_000)
    return { url, ...r }
  })
  const missing = assetResults.filter((r) => !r.ok)

  if (missing.length > 0) {
    issues.push({
      type: 'technical.assets.missing',
      category: 'TECHNICAL',
      severity: missing.length >= 3 ? 'HIGH' : 'MEDIUM',
      confidence: 'HIGH',
      title: `${missing.length} referenced asset(s) fail to load`,
      description:
        'Images or scripts referenced by the page return an error. Broken images are immediately visible to visitors.',
      evidence: {
        checked: assetResults.length,
        missing: missing.slice(0, 10).map((m) => ({ url: m.url, status: m.status, reason: m.reason })),
      },
      affectedUrl: home?.finalUrl ?? crawl.origin,
      recommendedAction: 'Re-upload the missing files or correct the paths.',
    })
  }

  const facts: TechnicalFacts = {
    finalStatusCode,
    redirectCount: redirectChain.length,
    redirectChain,
    isHttps,
    httpsRedirects,
    mixedContentCount,
    brokenLinks: brokenLinkDetails.length,
    checkedLinks: linkResults.length,
    missingAssets: missing.length,
    consoleErrors: input.consoleErrors ?? 0,
    serverHeader: headerOf(crawl, 'server'),
    poweredBy: headerOf(crawl, 'x-powered-by'),
  }

  return { facts, issues, brokenLinkDetails }
}

/** Reads a response header from the homepage fetch, or null when absent. */
function headerOf(crawl: CrawlResult, name: string): string | null {
  const home = crawl.pages.find((p) => p.role === 'home') ?? crawl.pages[0]
  return home?.headers?.[name] ?? null
}

function pickLinksToCheck(crawl: CrawlResult, limit: number): string[] {
  const origin = normalizeUrl(crawl.origin)?.domain
  const internal: string[] = []
  const external: string[] = []

  for (const link of crawl.discoveredLinks) {
    const n = normalizeUrl(link)
    if (!n) continue
    if (n.domain === origin) internal.push(n.href)
    else external.push(n.href)
  }

  // Internal links matter more: they are the site's own responsibility.
  const internalShare = Math.ceil(limit * 0.75)
  return [
    ...dedupe(internal).slice(0, internalShare),
    ...dedupe(external).slice(0, limit - Math.min(internalShare, internal.length)),
  ]
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

/** Bounded-concurrency map — protects both us and the site being audited. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i]!)
      } catch (err) {
        // A failed check is data, not a reason to abandon the others.
        results[i] = { ok: false, status: null, reason: (err as Error).message } as R
      }
    }
  })

  await Promise.all(workers)
  return results
}
