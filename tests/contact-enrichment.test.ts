import { describe, it, expect } from 'vitest'
import { extractContactsFromCrawl } from '@/server/leads/contact-enrichment'
import type { CrawlResult, CrawledDoc } from '@/server/crawler/crawl'

/**
 * Contact enrichment reads the business's *own* website — the site we already
 * have permission to crawl and are already auditing — to fill gaps the discovery
 * providers left. These tests pin the extraction rules, including the ones that
 * exist to avoid inventing contact details.
 */

const ORIGIN = 'https://enrich-fixture.invalid'

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
    loadMs: 50,
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
    robots: { found: true, url: `${ORIGIN}/robots.txt`, groups: [], sitemaps: [], crawlDelaySeconds: null, raw: null },
    pages,
    discoveredLinks: [],
    blockedByRobots: [],
    homeReachable: true,
    fatalError: null,
  }
}

/** Generic so filtering by kind does not erase the contact's other fields. */
const kinds = <T extends { kind: string }>(cs: T[], k: string): T[] =>
  cs.filter((c) => c.kind === k)

describe('explicit contact links', () => {
  it('extracts mailto and tel links', () => {
    const contacts = extractContactsFromCrawl(
      crawl([
        page(`<html><body>
          <a href="mailto:hello@practice.co.uk">Email us</a>
          <a href="tel:+441612345678">Call us</a>
        </body></html>`),
      ]),
      'GB',
    )

    expect(kinds(contacts, 'EMAIL')[0]?.normalized).toBe('hello@practice.co.uk')
    expect(kinds(contacts, 'PHONE')[0]?.normalized).toBe('+441612345678')
  })

  it('strips query strings from mailto and tel', () => {
    const contacts = extractContactsFromCrawl(
      crawl([
        page(`<html><body>
          <a href="mailto:hi@acme.com?subject=Enquiry">Email</a>
        </body></html>`),
      ]),
      'GB',
    )
    expect(kinds(contacts, 'EMAIL')[0]?.normalized).toBe('hi@acme.com')
  })

  it('collects social profiles', () => {
    const contacts = extractContactsFromCrawl(
      crawl([
        page(`<html><body>
          <a href="https://www.facebook.com/acmedental">Facebook</a>
          <a href="https://instagram.com/acmedental">Instagram</a>
          <a href="/about">About</a>
        </body></html>`),
      ]),
      'GB',
    )
    const socials = kinds(contacts, 'SOCIAL')
    expect(socials.length).toBe(2)
    expect(socials.map((s) => s.label).sort()).toEqual(['facebook', 'instagram'])
    // An internal page is not a social profile.
    expect(socials.some((s) => s.value.includes('/about'))).toBe(false)
  })
})

describe('body-text extraction', () => {
  it('finds an email in plain text', () => {
    const contacts = extractContactsFromCrawl(
      crawl([page('<html><body><p>Reach us at reception@clinic.co.uk any time.</p></body></html>')]),
      'GB',
    )
    expect(kinds(contacts, 'EMAIL')[0]?.normalized).toBe('reception@clinic.co.uk')
  })

  it('only takes a bare number when the surrounding text says it is a phone', () => {
    const withContext = extractContactsFromCrawl(
      crawl([page('<html><body><p>Phone: 0161 234 5678</p></body></html>')]),
      'GB',
    )
    expect(kinds(withContext, 'PHONE').length).toBe(1)

    // A number with no phone context could be anything — a price, a company
    // number, an address. Guessing would fabricate a contact detail.
    const withoutContext = extractContactsFromCrawl(
      crawl([page('<html><body><p>Established 1998. Registered 0161 234 5678</p></body></html>')]),
      'GB',
    )
    expect(kinds(withoutContext, 'PHONE').length).toBe(0)
  })

  it('rejects placeholder addresses', () => {
    const contacts = extractContactsFromCrawl(
      crawl([page('<html><body><p>Contact info@example.com for details</p></body></html>')]),
      'GB',
    )
    expect(kinds(contacts, 'EMAIL').length).toBe(0)
  })
})

describe('deduplication and robustness', () => {
  it('deduplicates the same contact found several ways across pages', () => {
    const html = `<html><body>
      <a href="mailto:hello@acme.co.uk">Email</a>
      <p>Or write to hello@acme.co.uk</p>
    </body></html>`
    const contacts = extractContactsFromCrawl(
      crawl([
        page(html),
        page(html, { role: 'contact', finalUrl: `${ORIGIN}/contact` }),
      ]),
      'GB',
    )
    expect(kinds(contacts, 'EMAIL').length).toBe(1)
  })

  it('skips pages that failed to load', () => {
    const contacts = extractContactsFromCrawl(
      crawl([
        page('', { error: 'timed out', errorKind: 'timeout', status: null }),
        page('<html><body><a href="mailto:ok@acme.com">Email</a></body></html>', {
          finalUrl: `${ORIGIN}/contact`,
        }),
      ]),
      'GB',
    )
    expect(kinds(contacts, 'EMAIL').length).toBe(1)
  })

  it('returns nothing for a site with no contact details rather than guessing', () => {
    const contacts = extractContactsFromCrawl(
      crawl([page('<html><body><h1>Welcome</h1><p>We do great work.</p></body></html>')]),
      'GB',
    )
    expect(contacts).toEqual([])
  })

  it('records the page each contact came from, for provenance', () => {
    const contacts = extractContactsFromCrawl(
      crawl([
        page('<html><body><a href="mailto:a@b.com">Email</a></body></html>', {
          finalUrl: `${ORIGIN}/contact`,
        }),
      ]),
      'GB',
    )
    expect(contacts[0]?.sourceUrl).toBe(`${ORIGIN}/contact`)
    expect(contacts[0]?.confidence).toBeGreaterThan(0)
  })
})
