import 'server-only'
import * as cheerio from 'cheerio'
import { resolveUrl, normalizeUrl } from '@/server/normalize/url'
import { safeFetch } from '@/server/crawler/fetch'
import type { CrawledDoc, CrawlResult } from '@/server/crawler/crawl'
import type { IssueDraft } from '../types'

/**
 * Deterministic SEO rules (§4 Tab 3, §5).
 *
 * Every rule answers a question that has a factual answer: does this element
 * exist, what does it contain, how long is it, what did that URL return. There
 * is no model in this file and no room for one — an SEO finding that cannot be
 * reproduced by re-running the check does not belong in a sales conversation.
 */

export interface SeoFacts {
  title: string | null
  titleLength: number | null
  metaDescription: string | null
  metaDescLength: number | null
  h1Count: number
  h1Text: string | null
  canonicalUrl: string | null
  robotsTxtFound: boolean
  robotsTxtUrl: string | null
  sitemapFound: boolean
  sitemapUrl: string | null
  isIndexable: boolean
  noindexReason: string | null
  hasOpenGraph: boolean
  hasStructuredData: boolean
  schemaTypes: string[]
  hasLocalBusinessSchema: boolean
  imagesTotal: number
  imagesMissingAlt: number
  internalLinks: number
  brokenInternalLinks: number
  wordCount: number | null
  duplicateTitles: number
  duplicateDescriptions: number
}

// Widely-cited SERP truncation thresholds. Kept here as named constants so they
// are tunable rather than scattered through the rules.
const TITLE_MIN = 30
const TITLE_MAX = 60
const DESC_MIN = 70
const DESC_MAX = 160
const THIN_CONTENT_WORDS = 250

export interface SeoInput {
  crawl: CrawlResult
  /** Results of the broken-link check performed by the technical stage. */
  brokenLinks: Array<{ url: string; status: number | null; reason: string | null }>
  businessName: string
}

export async function runSeoAudit(
  input: SeoInput,
): Promise<{ facts: SeoFacts; issues: IssueDraft[] }> {
  const { crawl, brokenLinks, businessName } = input
  const issues: IssueDraft[] = []

  const home = crawl.pages.find((p) => p.role === 'home') ?? crawl.pages[0]
  if (!home || !home.html) {
    throw new Error('No readable homepage HTML to audit')
  }

  const $ = cheerio.load(home.html)
  const pageUrl = home.finalUrl

  // ── Title ──────────────────────────────────────────────────────────────────
  const title = text($('head title').first().text())
  const titleLength = title?.length ?? null

  if (!title) {
    issues.push({
      type: 'seo.title.missing',
      category: 'SEO',
      severity: 'CRITICAL',
      confidence: 'HIGH',
      title: 'Missing page title',
      description:
        'The homepage has no <title> element. Search engines use it as the clickable headline in results, and browsers use it as the tab label.',
      evidence: {
        selector: 'head > title',
        found: false,
        headSnippet: snippet($('head').html() ?? '', 400),
      },
      affectedUrl: pageUrl,
      recommendedAction: `Add a <title> of ${TITLE_MIN}-${TITLE_MAX} characters containing the business name and primary service, e.g. "${businessName} | <service> in <town>".`,
    })
  } else if (titleLength! < TITLE_MIN) {
    issues.push({
      type: 'seo.title.too_short',
      category: 'SEO',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `Page title is only ${titleLength} characters`,
      description: `Short titles waste available space in search results. ${TITLE_MIN}-${TITLE_MAX} characters is the usable range.`,
      evidence: { selector: 'head > title', value: title, length: titleLength, min: TITLE_MIN },
      affectedUrl: pageUrl,
      recommendedAction: 'Extend the title with the primary service and location.',
    })
  } else if (titleLength! > TITLE_MAX) {
    issues.push({
      type: 'seo.title.too_long',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `Page title is ${titleLength} characters and will be truncated`,
      description: `Titles over roughly ${TITLE_MAX} characters are cut off in search results.`,
      evidence: { selector: 'head > title', value: title, length: titleLength, max: TITLE_MAX },
      affectedUrl: pageUrl,
      recommendedAction: `Shorten the title to under ${TITLE_MAX} characters, front-loading the most important words.`,
    })
  }

  // ── Meta description ───────────────────────────────────────────────────────
  const metaDescription = text($('meta[name="description"]').attr('content'))
  const metaDescLength = metaDescription?.length ?? null

  if (!metaDescription) {
    issues.push({
      type: 'seo.meta_description.missing',
      category: 'SEO',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: 'Missing meta description',
      description:
        'No meta description was found. Search engines then generate their own snippet from page text, which is rarely the pitch the business would choose.',
      evidence: {
        selector: 'meta[name="description"]',
        found: false,
        metaTagsPresent: $('head meta[name]')
          .map((_, el) => $(el).attr('name'))
          .get()
          .slice(0, 20),
      },
      affectedUrl: pageUrl,
      recommendedAction: `Add a meta description of ${DESC_MIN}-${DESC_MAX} characters summarising the service and location, with a reason to click.`,
    })
  } else if (metaDescLength! < DESC_MIN) {
    issues.push({
      type: 'seo.meta_description.too_short',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `Meta description is only ${metaDescLength} characters`,
      description: 'A very short description leaves most of the available snippet space unused.',
      evidence: { selector: 'meta[name="description"]', value: metaDescription, length: metaDescLength },
      affectedUrl: pageUrl,
      recommendedAction: `Expand to ${DESC_MIN}-${DESC_MAX} characters.`,
    })
  } else if (metaDescLength! > DESC_MAX) {
    issues.push({
      type: 'seo.meta_description.too_long',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `Meta description is ${metaDescLength} characters and will be truncated`,
      description: `Descriptions beyond roughly ${DESC_MAX} characters are cut off.`,
      evidence: { selector: 'meta[name="description"]', value: metaDescription, length: metaDescLength },
      affectedUrl: pageUrl,
      recommendedAction: `Trim to under ${DESC_MAX} characters.`,
    })
  }

  // ── Headings ───────────────────────────────────────────────────────────────
  const h1s = $('h1')
    .map((_, el) => text($(el).text()))
    .get()
    .filter((t): t is string => Boolean(t))
  const h1Count = h1s.length

  if (h1Count === 0) {
    issues.push({
      type: 'seo.h1.missing',
      category: 'SEO',
      severity: 'HIGH',
      confidence: 'HIGH',
      title: 'No H1 heading on the homepage',
      description:
        'The H1 is the primary on-page signal of what a page is about, and the first landmark screen-reader users navigate to.',
      evidence: {
        selector: 'h1',
        count: 0,
        headingsFound: $('h1,h2,h3')
          .map((_, el) => `${el.tagName.toLowerCase()}: ${text($(el).text())?.slice(0, 60)}`)
          .get()
          .slice(0, 10),
      },
      affectedUrl: pageUrl,
      recommendedAction: 'Add exactly one H1 describing the core service and location.',
    })
  } else if (h1Count > 1) {
    issues.push({
      type: 'seo.h1.multiple',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `${h1Count} H1 headings compete on one page`,
      description:
        'Multiple H1s dilute the page topic signal and make the document outline ambiguous.',
      evidence: { selector: 'h1', count: h1Count, values: h1s.slice(0, 8) },
      affectedUrl: pageUrl,
      recommendedAction: 'Keep one H1 and demote the rest to H2.',
    })
  }

  // Heading hierarchy: report skipped levels (H2 → H4) as a structural problem.
  const headingLevels = $('h1,h2,h3,h4,h5,h6')
    .map((_, el) => ({
      level: Number(el.tagName[1]),
      text: text($(el).text())?.slice(0, 60) ?? '',
    }))
    .get()

  const skips: Array<{ from: number; to: number; text: string }> = []
  for (let i = 1; i < headingLevels.length; i++) {
    const prev = headingLevels[i - 1]!
    const cur = headingLevels[i]!
    if (cur.level - prev.level > 1) {
      skips.push({ from: prev.level, to: cur.level, text: cur.text })
    }
  }
  if (skips.length > 0) {
    issues.push({
      type: 'seo.headings.hierarchy_skipped',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `Heading levels skip ${skips.length} time(s)`,
      description:
        'Jumping heading levels (for example H2 straight to H4) breaks the document outline that search engines and screen readers rely on.',
      evidence: { skips: skips.slice(0, 10), outline: headingLevels.slice(0, 25) },
      affectedUrl: pageUrl,
      recommendedAction: 'Use heading levels in sequence; style with CSS rather than by choosing a smaller tag.',
    })
  }

  // ── Indexability ───────────────────────────────────────────────────────────
  const robotsMeta = text($('meta[name="robots"]').attr('content'))?.toLowerCase() ?? null
  const xRobots = home.html ? null : null // header-based check happens in technical stage
  let isIndexable = true
  let noindexReason: string | null = null

  if (robotsMeta?.includes('noindex')) {
    isIndexable = false
    noindexReason = `<meta name="robots" content="${robotsMeta}">`
    issues.push({
      type: 'seo.indexability.noindex',
      category: 'SEO',
      severity: 'CRITICAL',
      confidence: 'HIGH',
      title: 'Homepage is set to noindex',
      description:
        'The homepage instructs search engines not to index it. While this is set, the site cannot appear in organic search results at all.',
      evidence: { selector: 'meta[name="robots"]', value: robotsMeta },
      affectedUrl: pageUrl,
      recommendedAction:
        'Remove noindex from the homepage unless it is deliberately private. This is frequently left over from a staging site.',
    })
  }

  // ── Canonical ──────────────────────────────────────────────────────────────
  const canonicalRaw = text($('link[rel="canonical"]').attr('href'))
  const canonicalUrl = canonicalRaw ? resolveUrl(pageUrl, canonicalRaw) : null

  if (!canonicalUrl) {
    issues.push({
      type: 'seo.canonical.missing',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: 'No canonical URL declared',
      description:
        'Without a canonical tag, the same page reachable at several addresses (with/without www, with tracking parameters) can be treated as duplicate content.',
      evidence: { selector: 'link[rel="canonical"]', found: false },
      affectedUrl: pageUrl,
      recommendedAction: 'Add a self-referencing canonical link to the homepage.',
    })
  } else {
    const canonHost = normalizeUrl(canonicalUrl)?.domain
    const pageHost = normalizeUrl(pageUrl)?.domain
    if (canonHost && pageHost && canonHost !== pageHost) {
      issues.push({
        type: 'seo.canonical.cross_domain',
        category: 'SEO',
        severity: 'HIGH',
        confidence: 'HIGH',
        title: 'Canonical tag points at a different domain',
        description:
          'The homepage tells search engines that the authoritative version lives on another domain, which suppresses this site in search results.',
        evidence: { canonical: canonicalUrl, pageUrl, canonicalHost: canonHost, pageHost },
        affectedUrl: pageUrl,
        recommendedAction:
          'Point the canonical at this page unless the content is genuinely syndicated from elsewhere.',
      })
    }
  }

  // ── robots.txt & sitemap ───────────────────────────────────────────────────
  if (!crawl.robots.found) {
    issues.push({
      type: 'seo.robots_txt.missing',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: 'No robots.txt file',
      description:
        'robots.txt is where crawl rules and the sitemap location are declared. Its absence is not fatal but is a sign the site was never configured for search.',
      evidence: { url: `${crawl.origin}/robots.txt`, found: false },
      affectedUrl: `${crawl.origin}/robots.txt`,
      recommendedAction: 'Add a robots.txt that allows crawling and lists the XML sitemap.',
    })
  }

  const sitemap = await findSitemap(crawl)
  if (!sitemap.found) {
    issues.push({
      type: 'seo.sitemap.missing',
      category: 'SEO',
      severity: 'MEDIUM',
      confidence: sitemap.checkedUrls.length > 0 ? 'HIGH' : 'MEDIUM',
      title: 'No XML sitemap found',
      description:
        'A sitemap helps search engines discover every page, which matters most for sites with weak internal linking.',
      evidence: {
        checkedUrls: sitemap.checkedUrls,
        declaredInRobots: crawl.robots.sitemaps,
        found: false,
      },
      affectedUrl: `${crawl.origin}/sitemap.xml`,
      recommendedAction:
        'Generate an XML sitemap and reference it from robots.txt and Search Console.',
    })
  }

  // ── Structured data ────────────────────────────────────────────────────────
  const schemaTypes = extractSchemaTypes($)
  const hasStructuredData = schemaTypes.length > 0
  const hasLocalBusinessSchema = schemaTypes.some((t) =>
    /LocalBusiness|Dentist|Restaurant|Store|ProfessionalService|MedicalBusiness|HomeAndConstructionBusiness|AutomotiveBusiness|LegalService|HealthAndBeautyBusiness/i.test(
      t,
    ),
  )

  if (!hasStructuredData) {
    issues.push({
      type: 'seo.schema.missing',
      category: 'SEO',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: 'No structured data on the homepage',
      description:
        'No JSON-LD or microdata was found. Structured data is what produces rich results — opening hours, ratings, address — in search listings.',
      evidence: {
        selector: 'script[type="application/ld+json"], [itemtype]',
        jsonLdBlocks: $('script[type="application/ld+json"]').length,
        microdataNodes: $('[itemtype]').length,
      },
      affectedUrl: pageUrl,
      recommendedAction:
        'Add LocalBusiness JSON-LD with name, address, telephone, opening hours and geo coordinates.',
    })
  } else if (!hasLocalBusinessSchema) {
    issues.push({
      type: 'seo.schema.no_local_business',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'MEDIUM',
      title: 'Structured data present but no LocalBusiness type',
      description:
        'The page declares structured data but not a LocalBusiness type, so local search features cannot use it.',
      evidence: { schemaTypes },
      affectedUrl: pageUrl,
      recommendedAction: 'Add a LocalBusiness (or more specific subtype) entity alongside the existing schema.',
    })
  }

  // ── Open Graph ─────────────────────────────────────────────────────────────
  const ogTitle = $('meta[property="og:title"]').attr('content')
  const ogImage = $('meta[property="og:image"]').attr('content')
  const hasOpenGraph = Boolean(ogTitle || ogImage)

  if (!hasOpenGraph) {
    issues.push({
      type: 'seo.open_graph.missing',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: 'No Open Graph tags',
      description:
        'When the site is shared on social platforms or messaging apps, no title or preview image is supplied, so the link renders as a bare URL.',
      evidence: {
        selector: 'meta[property^="og:"]',
        found: $('meta[property^="og:"]').length,
      },
      affectedUrl: pageUrl,
      recommendedAction: 'Add og:title, og:description, og:image and og:url.',
    })
  }

  // ── Images / alt text ──────────────────────────────────────────────────────
  const imgs = $('img')
  const imagesTotal = imgs.length
  const missingAltExamples: string[] = []
  let imagesMissingAlt = 0

  imgs.each((_, el) => {
    const alt = $(el).attr('alt')
    const src = $(el).attr('src') ?? $(el).attr('data-src') ?? ''
    // A present-but-empty alt is the correct markup for decorative images.
    if (alt === undefined) {
      imagesMissingAlt++
      if (missingAltExamples.length < 8) missingAltExamples.push(src.slice(0, 160))
    }
  })

  if (imagesMissingAlt > 0) {
    const share = imagesTotal > 0 ? imagesMissingAlt / imagesTotal : 0
    issues.push({
      type: 'seo.images.missing_alt',
      category: 'ACCESSIBILITY',
      severity: share > 0.5 ? 'MEDIUM' : 'LOW',
      confidence: 'HIGH',
      title: `${imagesMissingAlt} of ${imagesTotal} images have no alt attribute`,
      description:
        'Images without an alt attribute are invisible to screen readers and contribute nothing to image search.',
      evidence: {
        selector: 'img:not([alt])',
        missing: imagesMissingAlt,
        total: imagesTotal,
        examples: missingAltExamples,
      },
      affectedUrl: pageUrl,
      recommendedAction:
        'Add descriptive alt text to meaningful images and alt="" to purely decorative ones.',
    })
  }

  // ── Internal linking & content depth ───────────────────────────────────────
  const internalLinks = crawl.discoveredLinks.filter((l) => {
    const n = normalizeUrl(l)
    const o = normalizeUrl(crawl.origin)
    return n && o && n.domain === o.domain
  }).length

  const bodyText = text($('body').text()) ?? ''
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0

  if (wordCount < THIN_CONTENT_WORDS) {
    issues.push({
      type: 'seo.content.thin',
      category: 'CONTENT',
      severity: 'MEDIUM',
      confidence: 'MEDIUM',
      title: `Homepage has only ~${wordCount} words of text`,
      description:
        'There is very little indexable text. Search engines have almost nothing to match a query against, and visitors have little to read.',
      evidence: { wordCount, threshold: THIN_CONTENT_WORDS, sample: bodyText.slice(0, 300) },
      affectedUrl: pageUrl,
      // Confidence is MEDIUM on purpose: text rendered by JavaScript is not in
      // the served HTML, so this can understate a JS-heavy site.
      recommendedAction:
        'Add substantive copy covering services, areas served and common questions. Verify first whether content is rendered client-side.',
    })
  }

  // ── Broken internal links (measured by the technical stage) ────────────────
  const brokenInternal = brokenLinks.filter((b) => {
    const n = normalizeUrl(b.url)
    const o = normalizeUrl(crawl.origin)
    return n && o && n.domain === o.domain
  })

  if (brokenInternal.length > 0) {
    issues.push({
      type: 'seo.links.broken_internal',
      category: 'SEO',
      severity: brokenInternal.length >= 5 ? 'HIGH' : 'MEDIUM',
      confidence: 'HIGH',
      title: `${brokenInternal.length} broken internal link(s)`,
      description:
        'Links on the site point at pages that do not load. Visitors hit dead ends and crawl budget is wasted.',
      evidence: {
        count: brokenInternal.length,
        links: brokenInternal.slice(0, 12).map((b) => ({
          url: b.url,
          status: b.status,
          reason: b.reason,
        })),
      },
      affectedUrl: pageUrl,
      recommendedAction: 'Fix or redirect each broken URL listed in the evidence.',
    })
  }

  // ── Duplicate titles / descriptions across the crawled set ─────────────────
  const { duplicateTitles, duplicateDescriptions, dupeEvidence } =
    findDuplicates(crawl.pages)

  if (duplicateTitles > 0) {
    issues.push({
      type: 'seo.title.duplicate',
      category: 'SEO',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `${duplicateTitles} pages share a duplicate title`,
      description:
        'Pages with identical titles compete with each other in search results and give users no way to tell them apart.',
      evidence: { groups: dupeEvidence.titles },
      affectedUrl: pageUrl,
      recommendedAction: 'Write a unique, descriptive title for each page.',
    })
  }

  if (duplicateDescriptions > 0) {
    issues.push({
      type: 'seo.meta_description.duplicate',
      category: 'SEO',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `${duplicateDescriptions} pages share a duplicate meta description`,
      description: 'Repeated descriptions across pages waste the snippet opportunity.',
      evidence: { groups: dupeEvidence.descriptions },
      affectedUrl: pageUrl,
      recommendedAction: 'Write a unique meta description per page.',
    })
  }

  const facts: SeoFacts = {
    title,
    titleLength,
    metaDescription,
    metaDescLength,
    h1Count,
    h1Text: h1s[0] ?? null,
    canonicalUrl,
    robotsTxtFound: crawl.robots.found,
    robotsTxtUrl: crawl.robots.found ? crawl.robots.url : null,
    sitemapFound: sitemap.found,
    sitemapUrl: sitemap.url,
    isIndexable,
    noindexReason,
    hasOpenGraph,
    hasStructuredData,
    schemaTypes,
    hasLocalBusinessSchema,
    imagesTotal,
    imagesMissingAlt,
    internalLinks,
    brokenInternalLinks: brokenInternal.length,
    wordCount,
    duplicateTitles,
    duplicateDescriptions,
  }

  void xRobots
  return { facts, issues }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function text(v: string | null | undefined): string | null {
  if (!v) return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t || null
}

function snippet(html: string, max: number): string {
  return html.replace(/\s+/g, ' ').trim().slice(0, max)
}

function extractSchemaTypes($: cheerio.CheerioAPI): string[] {
  const types = new Set<string>()

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text()
    if (!raw?.trim()) return
    try {
      const parsed = JSON.parse(raw)
      collectTypes(parsed, types)
    } catch {
      // Malformed JSON-LD is itself worth knowing about, but it is not a type.
    }
  })

  $('[itemtype]').each((_, el) => {
    const t = $(el).attr('itemtype')
    if (t) types.add(t.split('/').pop() ?? t)
  })

  return Array.from(types).slice(0, 30)
}

function collectTypes(node: unknown, out: Set<string>): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const t = obj['@type']
  if (typeof t === 'string') out.add(t)
  else if (Array.isArray(t)) for (const v of t) if (typeof v === 'string') out.add(v)
  if (Array.isArray(obj['@graph'])) collectTypes(obj['@graph'], out)
}

async function findSitemap(
  crawl: CrawlResult,
): Promise<{ found: boolean; url: string | null; checkedUrls: string[] }> {
  const candidates = [
    ...crawl.robots.sitemaps,
    `${crawl.origin}/sitemap.xml`,
    `${crawl.origin}/sitemap_index.xml`,
    `${crawl.origin}/sitemap-index.xml`,
  ]
  const checked: string[] = []

  for (const candidate of candidates.slice(0, 4)) {
    checked.push(candidate)
    try {
      const res = await safeFetch(candidate, {
        timeoutMs: 10_000,
        acceptTypes: [],
        maxBytes: 256 * 1024,
      })
      // Some hosts return a styled 404 page with a 200 status; require XML.
      if (res.ok && /<(urlset|sitemapindex)\b/i.test(res.body)) {
        return { found: true, url: candidate, checkedUrls: checked }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { found: false, url: null, checkedUrls: checked }
}

function findDuplicates(pages: CrawledDoc[]) {
  const titleMap = new Map<string, string[]>()
  const descMap = new Map<string, string[]>()

  for (const p of pages) {
    if (!p.html) continue
    const $ = cheerio.load(p.html)
    const t = text($('head title').first().text())
    const d = text($('meta[name="description"]').attr('content'))
    if (t) titleMap.set(t, [...(titleMap.get(t) ?? []), p.finalUrl])
    if (d) descMap.set(d, [...(descMap.get(d) ?? []), p.finalUrl])
  }

  const dupTitleGroups = Array.from(titleMap.entries()).filter(([, urls]) => urls.length > 1)
  const dupDescGroups = Array.from(descMap.entries()).filter(([, urls]) => urls.length > 1)

  return {
    duplicateTitles: dupTitleGroups.reduce((n, [, urls]) => n + urls.length, 0),
    duplicateDescriptions: dupDescGroups.reduce((n, [, urls]) => n + urls.length, 0),
    dupeEvidence: {
      titles: dupTitleGroups.slice(0, 5).map(([value, urls]) => ({ value, urls })),
      descriptions: dupDescGroups.slice(0, 5).map(([value, urls]) => ({
        value: value.slice(0, 120),
        urls,
      })),
    },
  }
}
