import { describe, it, expect } from 'vitest'
import { runSeoAudit } from '@/server/audit/seo'
import type { CrawlResult, CrawledDoc } from '@/server/crawler/crawl'

/**
 * §5 — deterministic SEO rules.
 *
 * The origin below uses the reserved `.invalid` TLD so the sitemap probe fails
 * DNS immediately and the tests stay hermetic; sitemap detection is asserted as
 * "not found", which is the correct answer for a host that does not exist.
 */

const ORIGIN = 'https://audit-fixture.invalid'

function page(html: string, over: Partial<CrawledDoc> = {}): CrawledDoc {
  return {
    url: `${ORIGIN}/`,
    normalizedUrl: `${ORIGIN}/`,
    finalUrl: `${ORIGIN}/`,
    role: 'home',
    status: 200,
    redirectChain: [],
    contentType: 'text/html',
    bytes: html.length,
    loadMs: 100,
    html,
    title: null,
    headers: {},
    error: null,
    errorKind: null,
    ...over,
  }
}

function crawl(pages: CrawledDoc[], robotsFound = true): CrawlResult {
  return {
    origin: ORIGIN,
    robots: {
      found: robotsFound,
      url: `${ORIGIN}/robots.txt`,
      groups: [],
      sitemaps: [],
      crawlDelaySeconds: null,
      raw: robotsFound ? 'User-agent: *\nDisallow:' : null,
    },
    pages,
    discoveredLinks: [],
    blockedByRobots: [],
    homeReachable: true,
    fatalError: null,
  }
}

const GOOD_HTML = `<!doctype html><html><head>
  <title>Manchester Dental Practice | Cosmetic and Family Dentistry</title>
  <meta name="description" content="Family and cosmetic dentistry in central Manchester. Same-day emergency appointments, transparent pricing and a friendly team you can trust.">
  <link rel="canonical" href="${ORIGIN}/">
  <meta property="og:title" content="Manchester Dental Practice">
  <meta property="og:image" content="${ORIGIN}/og.jpg">
  <script type="application/ld+json">{"@type":"Dentist","name":"Manchester Dental"}</script>
</head><body>
  <h1>Manchester Dental Practice</h1>
  <h2>Our treatments</h2>
  <img src="/a.jpg" alt="Reception">
  <p>${'Dentistry copy that is long enough to clear the thin-content threshold. '.repeat(20)}</p>
</body></html>`

async function audit(html: string, opts: { robotsFound?: boolean } = {}) {
  return runSeoAudit({
    crawl: crawl([page(html)], opts.robotsFound ?? true),
    brokenLinks: [],
    businessName: 'Manchester Dental Practice',
  })
}

function types(issues: Array<{ type: string }>) {
  return issues.map((i) => i.type)
}

describe('title rules', () => {
  it('flags a missing title as critical', async () => {
    const { issues, facts } = await audit('<html><head></head><body><h1>Hi</h1></body></html>')
    const found = issues.find((i) => i.type === 'seo.title.missing')
    expect(found).toBeDefined()
    expect(found?.severity).toBe('CRITICAL')
    expect(facts.title).toBeNull()
    // Evidence must record what was actually queried.
    expect(found?.evidence.selector).toBe('head > title')
    expect(found?.evidence.found).toBe(false)
  })

  it('flags a title that is too short and one that is too long', async () => {
    const short = await audit('<html><head><title>Dental</title></head><body></body></html>')
    expect(types(short.issues)).toContain('seo.title.too_short')

    const long = await audit(
      `<html><head><title>${'Very long dental practice title '.repeat(5)}</title></head><body></body></html>`,
    )
    expect(types(long.issues)).toContain('seo.title.too_long')
  })

  it('does not flag a well-formed title', async () => {
    const { issues } = await audit(GOOD_HTML)
    expect(types(issues)).not.toContain('seo.title.missing')
    expect(types(issues)).not.toContain('seo.title.too_short')
    expect(types(issues)).not.toContain('seo.title.too_long')
  })
})

describe('meta description rules', () => {
  it('flags a missing description and records which meta tags were present', async () => {
    const { issues } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title><meta name="viewport" content="x"></head><body></body></html>',
    )
    const found = issues.find((i) => i.type === 'seo.meta_description.missing')
    expect(found).toBeDefined()
    expect(found?.evidence.selector).toBe('meta[name="description"]')
    expect(Array.isArray(found?.evidence.metaTagsPresent)).toBe(true)
  })

  it('accepts a description of a sensible length', async () => {
    const { issues } = await audit(GOOD_HTML)
    expect(types(issues).filter((t) => t.startsWith('seo.meta_description'))).toEqual([])
  })
})

describe('heading rules', () => {
  it('flags a missing H1', async () => {
    const { issues } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title></head><body><h2>Sub</h2></body></html>',
    )
    expect(types(issues)).toContain('seo.h1.missing')
  })

  it('flags multiple competing H1s and lists them as evidence', async () => {
    const { issues } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title></head><body><h1>One</h1><h1>Two</h1></body></html>',
    )
    const found = issues.find((i) => i.type === 'seo.h1.multiple')
    expect(found?.evidence.count).toBe(2)
    expect(found?.evidence.values).toEqual(['One', 'Two'])
  })

  it('flags a skipped heading level', async () => {
    const { issues } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title></head><body><h1>A</h1><h4>D</h4></body></html>',
    )
    expect(types(issues)).toContain('seo.headings.hierarchy_skipped')
  })
})

describe('indexability and canonical', () => {
  it('treats noindex on the homepage as critical', async () => {
    const { issues, facts } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title><meta name="robots" content="noindex, nofollow"></head><body><h1>x</h1></body></html>',
    )
    const found = issues.find((i) => i.type === 'seo.indexability.noindex')
    expect(found?.severity).toBe('CRITICAL')
    expect(facts.isIndexable).toBe(false)
  })

  it('flags a canonical that points to another domain', async () => {
    const { issues } = await audit(
      `<html><head><title>A perfectly reasonable page title here</title><link rel="canonical" href="https://someoneelse.example/"></head><body><h1>x</h1></body></html>`,
    )
    expect(types(issues)).toContain('seo.canonical.cross_domain')
  })

  it('flags a missing canonical', async () => {
    const { issues } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title></head><body><h1>x</h1></body></html>',
    )
    expect(types(issues)).toContain('seo.canonical.missing')
  })
})

describe('structured data and social tags', () => {
  it('flags a page with no structured data at all', async () => {
    const { issues, facts } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title></head><body><h1>x</h1></body></html>',
    )
    expect(types(issues)).toContain('seo.schema.missing')
    expect(facts.hasStructuredData).toBe(false)
  })

  it('recognises LocalBusiness subtypes', async () => {
    const { facts } = await audit(GOOD_HTML)
    expect(facts.hasStructuredData).toBe(true)
    expect(facts.hasLocalBusinessSchema).toBe(true)
    expect(facts.schemaTypes).toContain('Dentist')
  })

  it('flags missing Open Graph tags', async () => {
    const { issues } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title></head><body><h1>x</h1></body></html>',
    )
    expect(types(issues)).toContain('seo.open_graph.missing')
  })
})

describe('image alt text', () => {
  it('counts images with no alt attribute but ignores intentionally empty alt', async () => {
    const { issues, facts } = await audit(
      `<html><head><title>A perfectly reasonable page title here</title></head><body>
        <h1>x</h1>
        <img src="/1.jpg">
        <img src="/2.jpg" alt="">
        <img src="/3.jpg" alt="Described">
      </body></html>`,
    )
    expect(facts.imagesTotal).toBe(3)
    // alt="" is correct markup for decorative images, so only one is missing.
    expect(facts.imagesMissingAlt).toBe(1)
    const found = issues.find((i) => i.type === 'seo.images.missing_alt')
    expect(found?.evidence.missing).toBe(1)
  })
})

describe('content depth', () => {
  it('flags thin content with reduced confidence', async () => {
    const { issues } = await audit(
      '<html><head><title>A perfectly reasonable page title here</title></head><body><h1>Welcome</h1><p>Hi.</p></body></html>',
    )
    const found = issues.find((i) => i.type === 'seo.content.thin')
    expect(found).toBeDefined()
    // Lower confidence because JS-rendered copy is absent from served HTML.
    expect(found?.confidence).toBe('MEDIUM')
  })
})

describe('broken links', () => {
  it('reports internal broken links supplied by the technical stage', async () => {
    const result = await runSeoAudit({
      crawl: crawl([page(GOOD_HTML)]),
      brokenLinks: [
        { url: `${ORIGIN}/gone`, status: 404, reason: 'HTTP 404' },
        { url: `${ORIGIN}/also-gone`, status: 404, reason: 'HTTP 404' },
        { url: 'https://external.invalid/x', status: null, reason: 'DNS' },
      ],
      businessName: 'Test',
    })
    const found = result.issues.find((i) => i.type === 'seo.links.broken_internal')
    expect(found?.evidence.count).toBe(2)
    expect(result.facts.brokenInternalLinks).toBe(2)
  })
})

describe('duplicate metadata across pages', () => {
  it('detects two pages sharing a title', async () => {
    const html = GOOD_HTML
    const result = await runSeoAudit({
      crawl: crawl([
        page(html),
        page(html, { role: 'about', url: `${ORIGIN}/about`, finalUrl: `${ORIGIN}/about` }),
      ]),
      brokenLinks: [],
      businessName: 'Test',
    })
    expect(types(result.issues)).toContain('seo.title.duplicate')
    expect(result.facts.duplicateTitles).toBe(2)
  })
})

describe('robots.txt', () => {
  it('flags a missing robots.txt', async () => {
    const { issues, facts } = await audit(GOOD_HTML, { robotsFound: false })
    expect(types(issues)).toContain('seo.robots_txt.missing')
    expect(facts.robotsTxtFound).toBe(false)
  })
})

describe('every finding carries evidence and a fix', () => {
  it('never emits an issue without both', async () => {
    const { issues } = await audit(
      '<html><head></head><body><p>Nothing here.</p></body></html>',
    )
    expect(issues.length).toBeGreaterThan(3)
    for (const i of issues) {
      expect(i.evidence, `${i.type} must have evidence`).toBeTruthy()
      expect(Object.keys(i.evidence).length).toBeGreaterThan(0)
      expect(i.recommendedAction.length).toBeGreaterThan(10)
      expect(i.title.length).toBeGreaterThan(3)
    }
  })
})
