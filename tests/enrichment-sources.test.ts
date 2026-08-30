import { describe, it, expect } from 'vitest'
import { candidateDomains } from '@/server/leads/website-finder'
import { extractStructuredData, hasStructuredData } from '@/server/leads/structured-data'
import type { CrawlResult, CrawledDoc } from '@/server/crawler/crawl'

const ORIGIN = 'https://sd-fixture.invalid'

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
    loadMs: 40,
    html,
    title: null,
    headers: {},
    error: null,
    errorKind: null,
    ...over,
  }
}

function crawl(pages: CrawledDoc[]): CrawlResult {
  return {
    origin: ORIGIN,
    robots: { found: true, url: '', groups: [], sitemaps: [], crawlDelaySeconds: null, raw: null },
    pages,
    discoveredLinks: [],
    blockedByRobots: [],
    homeReachable: true,
    fatalError: null,
  }
}

function ld(json: unknown): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head><body></body></html>`
}

describe('website candidate domains', () => {
  it('derives domain shapes from the business name', () => {
    const domains = candidateDomains({ name: 'Brooklyn Court Dental Practice', countryCode: 'GB' })
    expect(domains).toContain('brooklyncourtdentalpractice.co.uk')
    expect(domains).toContain('brooklyncourtdental.co.uk')
    expect(domains).toContain('brooklyncourt.co.uk')
  })

  it('uses country-appropriate TLDs', () => {
    const gb = candidateDomains({ name: 'Acme Dental', countryCode: 'GB' })
    const us = candidateDomains({ name: 'Acme Dental', countryCode: 'US' })
    expect(gb.some((d) => d.endsWith('.co.uk'))).toBe(true)
    expect(us.some((d) => d.endsWith('.com'))).toBe(true)
    expect(us.some((d) => d.endsWith('.co.uk'))).toBe(false)
  })

  it('falls back to generic TLDs for an unknown country', () => {
    const domains = candidateDomains({ name: 'Acme Dental', countryCode: 'ZZ' })
    expect(domains).toContain('acmedental.com')
  })

  it('drops legal suffixes so the domain matches how businesses register', () => {
    const domains = candidateDomains({ name: 'Acme Dental Ltd', countryCode: 'GB' })
    expect(domains).toContain('acmedental.co.uk')
  })

  it('stays within a bounded number of candidates', () => {
    const domains = candidateDomains({
      name: 'The Very Long Business Name With Many Separate Words Indeed',
      countryCode: 'GB',
    })
    expect(domains.length).toBeLessThanOrEqual(12)
  })

  it('returns nothing for a name with no usable tokens', () => {
    expect(candidateDomains({ name: '   ', countryCode: 'GB' })).toEqual([])
  })
})

describe('schema.org extraction', () => {
  it('reads a LocalBusiness node', () => {
    const d = extractStructuredData(
      crawl([
        page(
          ld({
            '@context': 'https://schema.org',
            '@type': 'Dentist',
            name: 'Brooklyn Court Dental',
            telephone: '+44 161 234 5678',
            email: 'hello@brooklyncourtdental.co.uk',
            priceRange: '££',
            address: {
              '@type': 'PostalAddress',
              streetAddress: '12 High Street',
              addressLocality: 'Manchester',
              postalCode: 'M20 2RN',
            },
            geo: { '@type': 'GeoCoordinates', latitude: 53.4084, longitude: -2.2374 },
            aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.8, reviewCount: 132 },
            sameAs: ['https://facebook.com/brooklyncourt'],
          }),
        ),
      ]),
      'GB',
    )

    expect(d.name).toBe('Brooklyn Court Dental')
    expect(d.phones).toContain('+441612345678')
    expect(d.emails).toContain('hello@brooklyncourtdental.co.uk')
    expect(d.addressLine).toBe('12 High Street')
    expect(d.postalCode).toBe('M20 2RN')
    expect(d.priceRange).toBe('££')
    expect(d.rating).toBe(4.8)
    expect(d.reviewCount).toBe(132)
    expect(d.socials.some((s) => s.includes('facebook.com'))).toBe(true)
    expect(d.schemaTypes).toContain('Dentist')
  })

  it('finds business nodes nested inside @graph', () => {
    const d = extractStructuredData(
      crawl([
        page(
          ld({
            '@context': 'https://schema.org',
            '@graph': [
              { '@type': 'WebSite', name: 'Site' },
              { '@type': 'LocalBusiness', name: 'Nested Co', telephone: '0161 234 5678' },
            ],
          }),
        ),
      ]),
      'GB',
    )
    expect(d.name).toBe('Nested Co')
    expect(d.phones).toContain('+441612345678')
  })

  it('ignores non-business schema types', () => {
    const d = extractStructuredData(
      crawl([page(ld({ '@type': 'Article', name: 'A blog post', author: 'Someone' }))]),
      'GB',
    )
    expect(d.name).toBeNull()
    expect(hasStructuredData(d)).toBe(false)
  })

  it('survives malformed JSON-LD without losing valid blocks', () => {
    const html = `<html><head>
      <script type="application/ld+json">{ this is not json }</script>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'LocalBusiness', name: 'Still Found', telephone: '0161 234 5678' })}</script>
    </head><body></body></html>`
    const d = extractStructuredData(crawl([page(html)]), 'GB')
    expect(d.name).toBe('Still Found')
  })

  it('rejects out-of-range coordinates and ratings rather than storing nonsense', () => {
    const d = extractStructuredData(
      crawl([
        page(
          ld({
            '@type': 'LocalBusiness',
            name: 'Bad Data Co',
            geo: { latitude: 0, longitude: 0 },
            aggregateRating: { ratingValue: 97, reviewCount: 10 },
          }),
        ),
      ]),
      'GB',
    )
    // Null island is a default, not a location.
    expect(d.latitude).toBeNull()
    // A 0-5 scale cannot be 97.
    expect(d.rating).toBeNull()
  })

  it('separates the business website from its social profiles', () => {
    const d = extractStructuredData(
      crawl([
        page(
          ld({
            '@type': 'LocalBusiness',
            name: 'Acme',
            url: 'https://acme-dental.example',
            sameAs: ['https://instagram.com/acme', 'https://twitter.com/acme'],
          }),
        ),
      ]),
      'GB',
    )
    expect(d.websites.some((w) => w.includes('acme-dental.example'))).toBe(true)
    expect(d.socials.length).toBe(2)
    expect(d.websites.some((w) => w.includes('instagram'))).toBe(false)
  })

  it('collects opening hours in both supported shapes', () => {
    const d = extractStructuredData(
      crawl([
        page(
          ld({
            '@type': 'LocalBusiness',
            name: 'Acme',
            openingHoursSpecification: [
              { dayOfWeek: ['https://schema.org/Monday'], opens: '09:00', closes: '17:00' },
            ],
            openingHours: ['Sa 10:00-14:00'],
          }),
        ),
      ]),
      'GB',
    )
    expect(d.openingHours.length).toBe(2)
    expect(d.openingHours.some((h) => h.includes('Monday'))).toBe(true)
  })

  it('returns empty output for a page with no structured data', () => {
    const d = extractStructuredData(crawl([page('<html><body><h1>Hi</h1></body></html>')]), 'GB')
    expect(hasStructuredData(d)).toBe(false)
    expect(d.phones).toEqual([])
  })

  it('skips pages that failed to load', () => {
    const d = extractStructuredData(
      crawl([
        page('', { error: 'timeout', status: null }),
        page(ld({ '@type': 'LocalBusiness', name: 'Second Page Co' }), {
          finalUrl: `${ORIGIN}/contact`,
        }),
      ]),
      'GB',
    )
    expect(d.name).toBe('Second Page Co')
    expect(d.sourceUrl).toBe(`${ORIGIN}/contact`)
  })
})
