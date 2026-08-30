import { describe, it, expect } from 'vitest'
import { DEFAULT_WEIGHTS, parseWeights } from '@/server/scoring/weights'
import {
  healthFromIssues, websiteHealth, dataConfidence, leadPriority,
  seoOpportunity, speedOpportunity, websiteCreationOpportunity, redesignOpportunity,
  businessValue,
} from '@/server/scoring/compute'
import type { IssueDraft } from '@/server/audit/types'

const W = DEFAULT_WEIGHTS

function issue(over: Partial<IssueDraft> = {}): IssueDraft {
  return {
    type: 'seo.title.missing',
    category: 'SEO',
    severity: 'HIGH',
    confidence: 'HIGH',
    title: 'Missing title',
    description: 'x',
    evidence: {},
    recommendedAction: 'y',
    ...over,
  }
}

describe('health scores', () => {
  it('scores a clean site 100', () => {
    expect(healthFromIssues([], W).score).toBe(100)
  })

  it('deducts more for severe issues', () => {
    const low = healthFromIssues([issue({ severity: 'LOW' })], W).score
    const critical = healthFromIssues([issue({ severity: 'CRITICAL' })], W).score
    expect(critical).toBeLessThan(low)
  })

  it('deducts less for low-confidence findings', () => {
    const high = healthFromIssues([issue({ confidence: 'HIGH' })], W).score
    const lowConf = healthFromIssues([issue({ confidence: 'LOW' })], W).score
    expect(lowConf).toBeGreaterThan(high)
  })

  it('never goes below zero', () => {
    const many = Array.from({ length: 40 }, () => issue({ severity: 'CRITICAL' }))
    expect(healthFromIssues(many, W).score).toBe(0)
  })

  it('always explains the score', () => {
    const r = healthFromIssues([issue()], W)
    expect(r.reasons.length).toBeGreaterThan(0)
  })
})

describe('website health composition', () => {
  it('re-weights over the domains that actually produced a score', () => {
    // A skipped UX stage must not drag the composite toward zero.
    const withUx = websiteHealth({ seo: 50, performance: 50, ux: 50, technical: 50 }, W)
    const withoutUx = websiteHealth({ seo: 50, performance: 50, ux: null, technical: 50 }, W)
    expect(withUx).toBe(50)
    expect(withoutUx).toBe(50)
  })

  it('returns null when nothing was measured', () => {
    expect(
      websiteHealth({ seo: null, performance: null, ux: null, technical: null }, W),
    ).toBeNull()
  })
})

describe('health and opportunity are inverse, not identical (§14)', () => {
  it('produces a high opportunity from a low SEO health', () => {
    const ctx = { weights: W, businessValue: 70 }
    const issues = Array.from({ length: 8 }, () => issue({ severity: 'HIGH' }))
    const opp = seoOpportunity({ seoHealth: 28, issues }, ctx)
    expect(opp.score).toBeGreaterThan(60)
    expect(opp.triggered).toBe(true)
    // The two numbers must not be the same value.
    expect(opp.score).not.toBe(28)
  })

  it('produces a low opportunity from a healthy site', () => {
    const ctx = { weights: W, businessValue: 70 }
    const opp = seoOpportunity({ seoHealth: 95, issues: [] }, ctx)
    expect(opp.triggered).toBe(false)
  })

  it('does not trigger an opportunity that was never measured', () => {
    const ctx = { weights: W, businessValue: 70 }
    expect(seoOpportunity({ seoHealth: null, issues: [] }, ctx).triggered).toBe(false)
    expect(
      speedOpportunity(
        { mobileScore: null, desktopScore: null, lcpMobileMs: null, clsMobile: null, issues: [] },
        ctx,
      ).triggered,
    ).toBe(false)
  })
})

describe('opportunities overlap (§5)', () => {
  it('lets one business qualify for several at once', () => {
    const ctx = { weights: W, businessValue: 80 }
    const seoIssues = Array.from({ length: 6 }, () => issue({ severity: 'HIGH' }))
    const uxIssues = Array.from({ length: 5 }, () =>
      issue({ category: 'UX', severity: 'HIGH', type: 'ux.layout.horizontal_overflow' }),
    )

    const seo = seoOpportunity({ seoHealth: 30, issues: seoIssues }, ctx)
    const speed = speedOpportunity(
      { mobileScore: 31, desktopScore: 55, lcpMobileMs: 5100, clsMobile: 0.31, issues: [] },
      ctx,
    )
    const redesign = redesignOpportunity(
      { uxHealth: 25, technicalHealth: 50, issues: uxIssues },
      ctx,
    )

    expect(seo.triggered).toBe(true)
    expect(speed.triggered).toBe(true)
    expect(redesign.triggered).toBe(true)
  })

  it('never triggers Website Creation for a business that has a website', () => {
    const ctx = { weights: W, businessValue: 80 }
    const r = websiteCreationOpportunity(
      {
        websiteStatus: 'REACHABLE',
        hasSocial: false,
        hasPhone: true,
        reviewCount: 100,
        rating: 4.5,
        isDemo: false,
      },
      ctx,
    )
    expect(r.triggered).toBe(false)
    expect(r.score).toBe(0)
  })

  it('triggers Website Creation when no website exists', () => {
    const ctx = { weights: W, businessValue: 80 }
    const r = websiteCreationOpportunity(
      {
        websiteStatus: 'NONE',
        hasSocial: true,
        hasPhone: true,
        reviewCount: 220,
        rating: 4.6,
        isDemo: false,
      },
      ctx,
    )
    expect(r.triggered).toBe(true)
    expect(r.reasons.length).toBeGreaterThan(0)
  })

  it('refuses to judge redesign when the UX stage never ran', () => {
    const ctx = { weights: W, businessValue: 80 }
    const r = redesignOpportunity({ uxHealth: null, technicalHealth: null, issues: [] }, ctx)
    expect(r.triggered).toBe(false)
    expect(r.reasons[0]?.label).toBe('Not assessed')
  })

  it('ignores AI-assisted findings when scoring redesign (§44)', () => {
    const ctx = { weights: W, businessValue: 80 }
    const aiOnly = Array.from({ length: 6 }, () =>
      issue({ category: 'UX', source: 'AI_ASSISTED', severity: 'HIGH' }),
    )
    const r = redesignOpportunity({ uxHealth: 100, technicalHealth: 90, issues: aiOnly }, ctx)
    expect(r.triggered).toBe(false)
  })
})

describe('lead priority (§15)', () => {
  const base = {
    opportunities: { websiteCreation: 0, redesign: 90, seo: 85, speed: 88 },
    hasPhone: true,
    hasEmail: true,
    hasSocial: true,
    rating: 4.6,
    reviewCount: 240,
    dataConfidence: 85,
    openingStatus: 'OPERATIONAL',
    issueCount: 14,
    isDemo: false,
    weights: W,
  }

  it('rates a credible, reachable business with clear need as HOT', () => {
    const r = leadPriority(base)
    expect(r.tier).toBe('HOT')
    expect(r.score).toBeGreaterThan(70)
  })

  it('does not rank an unreachable business above a reachable one', () => {
    const reachable = leadPriority(base)
    const unreachable = leadPriority({
      ...base,
      hasPhone: false,
      hasEmail: false,
      hasSocial: false,
    })
    expect(unreachable.score).toBeLessThan(reachable.score)
  })

  it('does not prioritise a business purely because its site is terrible', () => {
    // Terrible site, but no contact route, no reviews, low data confidence.
    const terribleButUseless = leadPriority({
      ...base,
      hasPhone: false,
      hasEmail: false,
      hasSocial: false,
      reviewCount: null,
      rating: null,
      dataConfidence: 20,
    })
    // Decent site, credible and reachable.
    const modestButGood = leadPriority({
      ...base,
      opportunities: { websiteCreation: 0, redesign: 50, seo: 48, speed: 46 },
      issueCount: 4,
    })
    expect(modestButGood.score).toBeGreaterThan(terribleButUseless.score)
  })

  it('suppresses permanently closed businesses', () => {
    const r = leadPriority({ ...base, openingStatus: 'CLOSED_PERMANENTLY' })
    expect(r.score).toBeLessThanOrEqual(10)
  })

  it('suppresses demo records so they never top the list', () => {
    const live = leadPriority(base)
    const demo = leadPriority({ ...base, isDemo: true })
    expect(demo.score).toBeLessThan(live.score)
    expect(demo.reasons[0]?.label).toBe('DEMO DATA')
  })

  it('always explains the score', () => {
    expect(leadPriority(base).reasons.length).toBeGreaterThan(2)
  })
})

describe('data confidence', () => {
  it('rewards corroboration across sources', () => {
    const one = dataConfidence(
      {
        sourceCount: 1, hasPhone: true, hasEmail: false, hasAddress: true,
        hasCoordinates: true, hasWebsite: true, reviewCount: 10,
        websiteVerified: true, isDemo: false,
      },
      W,
    )
    const three = dataConfidence(
      {
        sourceCount: 3, hasPhone: true, hasEmail: false, hasAddress: true,
        hasCoordinates: true, hasWebsite: true, reviewCount: 10,
        websiteVerified: true, isDemo: false,
      },
      W,
    )
    expect(three.score).toBeGreaterThan(one.score)
  })

  it('penalises demo records heavily', () => {
    const demo = dataConfidence(
      {
        sourceCount: 1, hasPhone: true, hasEmail: true, hasAddress: true,
        hasCoordinates: true, hasWebsite: true, reviewCount: 100,
        websiteVerified: true, isDemo: true,
      },
      W,
    )
    expect(demo.reasons.some((r) => r.label === 'DEMO DATA')).toBe(true)
  })
})

describe('weights configuration', () => {
  it('falls back to defaults for corrupt input', () => {
    expect(parseWeights(null)).toEqual(DEFAULT_WEIGHTS)
    expect(parseWeights('nonsense')).toEqual(DEFAULT_WEIGHTS)
  })

  it('accepts a valid custom profile', () => {
    const custom = { ...DEFAULT_WEIGHTS, severity: { ...DEFAULT_WEIGHTS.severity, HIGH: 20 } }
    expect(parseWeights(custom).severity.HIGH).toBe(20)
  })

  it('changing weights changes the score', () => {
    const heavier = { ...W, severity: { ...W.severity, HIGH: 30 } }
    const a = healthFromIssues([issue({ severity: 'HIGH' })], W).score
    const b = healthFromIssues([issue({ severity: 'HIGH' })], heavier).score
    expect(b).toBeLessThan(a)
  })
})

describe('business value', () => {
  it('rises with reviews and rating', () => {
    const small = businessValue({ reviewCount: 2, rating: 3.0, hasPhone: false, dataConfidence: 40 })
    const large = businessValue({ reviewCount: 400, rating: 4.7, hasPhone: true, dataConfidence: 90 })
    expect(large).toBeGreaterThan(small)
  })
})
