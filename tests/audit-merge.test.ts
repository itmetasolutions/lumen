import { describe, it, expect } from 'vitest'
import { mergedSignals, EMPTY_SIGNALS, ALL_AUTHORITATIVE, type AuditSignals } from '@/server/audit/run'

/**
 * §26 — targeted re-audits must merge, not replace.
 *
 * This guards a bug that was live: a UX-only re-audit reset `seoHealth` to null
 * and cleared the SEO signal columns, which silently dropped the business out of
 * the SEO tab even though nothing about its SEO had been re-examined. The audit
 * history was intact; the denormalised projection every tab reads was not.
 */

const STORED: AuditSignals = {
  seoMissingTitle: true,
  seoMissingDescription: true,
  seoMissingH1: false,
  seoNoSitemap: true,
  seoNoSchema: true,
  seoNotIndexable: false,
  uxNoViewport: true,
  uxHorizontalOverflow: true,
  uxBrokenImages: 4,
  uxAccessibilityIssues: 9,
  uxNavigationIssues: 2,
  techNoHttps: true,
  techMixedContent: true,
}

const FRESH: AuditSignals = {
  ...EMPTY_SIGNALS,
  uxNoViewport: false,
  uxHorizontalOverflow: false,
  uxBrokenImages: 0,
  uxAccessibilityIssues: 1,
  uxNavigationIssues: 0,
}

describe('signal merging', () => {
  it('keeps stored SEO signals when only the UX stage ran', () => {
    const merged = mergedSignals(FRESH, STORED, {
      seo: false,
      ux: true,
      technical: false,
      performance: false,
    })

    // SEO findings were not re-examined — they must survive verbatim.
    expect(merged.seoMissingTitle).toBe(true)
    expect(merged.seoMissingDescription).toBe(true)
    expect(merged.seoNoSitemap).toBe(true)
    expect(merged.seoNoSchema).toBe(true)

    // Technical likewise.
    expect(merged.techNoHttps).toBe(true)
    expect(merged.techMixedContent).toBe(true)

    // UX was re-measured, so the fresh values win — including the improvement
    // from 4 broken images to 0.
    expect(merged.uxBrokenImages).toBe(0)
    expect(merged.uxNoViewport).toBe(false)
    expect(merged.uxHorizontalOverflow).toBe(false)
    expect(merged.uxAccessibilityIssues).toBe(1)
  })

  it('lets a full audit overwrite everything', () => {
    const merged = mergedSignals(FRESH, STORED, ALL_AUTHORITATIVE)
    expect(merged).toEqual(FRESH)
  })

  it('applies fresh values wholesale when there is no stored projection', () => {
    const merged = mergedSignals(FRESH, null, {
      seo: false,
      ux: false,
      technical: false,
      performance: false,
    })
    // A first audit has nothing to preserve, so it cannot be blocked from writing.
    expect(merged).toEqual(FRESH)
  })

  it('keeps stored UX signals when only SEO ran', () => {
    const merged = mergedSignals(EMPTY_SIGNALS, STORED, {
      seo: true,
      ux: false,
      technical: false,
      performance: false,
    })
    expect(merged.uxBrokenImages).toBe(4)
    expect(merged.uxAccessibilityIssues).toBe(9)
    expect(merged.uxNoViewport).toBe(true)
    // SEO was re-measured and came back clean.
    expect(merged.seoMissingTitle).toBe(false)
    expect(merged.seoNoSitemap).toBe(false)
  })

  it('treats missing stored fields as their empty default rather than undefined', () => {
    const merged = mergedSignals(EMPTY_SIGNALS, {}, {
      seo: false,
      ux: false,
      technical: false,
      performance: false,
    })
    expect(merged.uxBrokenImages).toBe(0)
    expect(merged.seoMissingTitle).toBe(false)
    expect(merged.techNoHttps).toBe(false)
  })
})
