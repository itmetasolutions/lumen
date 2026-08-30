import { describe, it, expect } from 'vitest'
import { expandTerms, isExcluded } from '@/server/discovery/expansion'
import { planTiles, planTilesForBBox, defaultRadiusFor } from '@/server/discovery/tiling'
import { normalizeRawBusiness } from '@/server/discovery/normalize'
import { MockProvider } from '@/server/discovery/providers/mock'
import { resolveColumns, cellValue, EXPORT_COLUMNS } from '@/server/export/columns'
import { haversineMeters } from '@/server/normalize/geo'
import type { RawBusiness } from '@/server/discovery/types'

describe('term expansion (§2)', () => {
  it("always puts the user's own term first and unexpanded", () => {
    const terms = expandTerms({ industry: 'Plumber', enabled: true })
    expect(terms[0]!.term).toBe('plumber')
    expect(terms[0]!.isExpanded).toBe(false)
  })

  it('marks every expansion as expanded and records its origin', () => {
    const terms = expandTerms({ industry: 'plumber', enabled: true })
    const expanded = terms.filter((t) => t.isExpanded)
    expect(expanded.length).toBeGreaterThan(0)
    expect(expanded.every((t) => t.originTerm === 'plumber')).toBe(true)
    expect(terms.map((t) => t.term)).toContain('emergency plumber')
  })

  it('returns only the original terms when expansion is off', () => {
    const terms = expandTerms({ industry: 'plumber', enabled: false })
    expect(terms.every((t) => !t.isExpanded)).toBe(true)
    expect(terms).toHaveLength(1)
  })

  it('handles plurals by finding the singular synonym set', () => {
    const terms = expandTerms({ industry: 'Dentists', enabled: true })
    expect(terms.map((t) => t.term)).toContain('dental clinic')
  })

  it('falls back to generic patterns for an unmapped industry', () => {
    const terms = expandTerms({ industry: 'alpaca groomer', enabled: true })
    expect(terms.length).toBeGreaterThan(1)
    expect(terms.map((t) => t.term)).toContain('alpaca groomer company')
  })

  it('respects the expansion cap so cost cannot run away', () => {
    const terms = expandTerms({ industry: 'plumber', enabled: true, max: 3 })
    expect(terms.length).toBeLessThanOrEqual(3)
  })

  it('deduplicates keywords that repeat the industry', () => {
    const terms = expandTerms({
      industry: 'plumber',
      keywords: ['Plumber', 'drain'],
      enabled: false,
    })
    expect(terms.filter((t) => t.term === 'plumber')).toHaveLength(1)
  })
})

describe('exclusions (§1)', () => {
  it('drops results whose name or category matches an exclusion', () => {
    expect(isExcluded({ name: 'City Hospital Dental Unit' }, ['hospital'])).toBe(true)
    expect(isExcluded({ name: 'ABC Dental', categories: ['hospital'] }, ['hospital'])).toBe(true)
    expect(isExcluded({ name: 'ABC Dental' }, ['hospital'])).toBe(false)
    expect(isExcluded({ name: 'ABC Dental' }, [])).toBe(false)
  })
})

describe('geographic tiling (§2)', () => {
  it('uses a single cell for a small radius', () => {
    const plan = planTiles({ centerLat: 53.48, centerLng: -2.24, radiusMeters: 1500 })
    expect(plan.summary.strategy).toBe('single')
    expect(plan.cells).toHaveLength(1)
  })

  it('subdivides a large radius into a grid', () => {
    const plan = planTiles({ centerLat: 53.48, centerLng: -2.24, radiusMeters: 20_000 })
    expect(plan.summary.strategy).toBe('grid')
    expect(plan.cells.length).toBeGreaterThan(4)
  })

  it('never exceeds the cell ceiling, even for a country-sized radius', () => {
    const plan = planTiles({ centerLat: 53.48, centerLng: -2.24, radiusMeters: 400_000 })
    expect(plan.cells.length).toBeLessThanOrEqual(144)
  })

  it('keeps every cell inside the requested circle', () => {
    const plan = planTiles({ centerLat: 53.48, centerLng: -2.24, radiusMeters: 20_000 })
    for (const cell of plan.cells) {
      const d = haversineMeters(53.48, -2.24, cell.lat, cell.lng)
      expect(d).toBeLessThanOrEqual(20_000 + cell.radiusMeters + 1)
    }
  })

  it('gives every cell a unique sequential index', () => {
    const plan = planTiles({ centerLat: 53.48, centerLng: -2.24, radiusMeters: 20_000 })
    expect(new Set(plan.cells.map((c) => c.index)).size).toBe(plan.cells.length)
  })

  it('tiles a bounding box', () => {
    const plan = planTilesForBBox({
      minLat: 53.4, minLng: -2.35, maxLat: 53.55, maxLng: -2.15,
    })
    expect(plan.cells.length).toBeGreaterThan(0)
  })

  it('scales the default radius with the administrative level', () => {
    expect(defaultRadiusFor('area')).toBeLessThan(defaultRadiusFor('city'))
    expect(defaultRadiusFor('city')).toBeLessThan(defaultRadiusFor('region'))
    expect(defaultRadiusFor('region')).toBeLessThan(defaultRadiusFor('country'))
  })
})

describe('provider normalisation (§2)', () => {
  const meta = { provider: 'test', isDemo: false, industry: 'dentist' }

  function raw(over: Partial<RawBusiness> = {}): RawBusiness {
    return { name: 'ABC Dental', raw: {}, confidence: 80, ...over }
  }

  it('rejects a record with no usable name', () => {
    expect(normalizeRawBusiness(raw({ name: '  ' }), meta)).toBeNull()
  })

  it('separates a real website from a social profile', () => {
    const d = normalizeRawBusiness(
      raw({ website: 'https://abcdental.co.uk', socials: ['https://facebook.com/abc'] }),
      meta,
    )!
    expect(d.websiteDomain).toBe('abcdental.co.uk')
    expect(d.websiteIsSocialOnly).toBe(false)
    expect(d.contacts.some((c) => c.kind === 'SOCIAL')).toBe(true)
  })

  it('marks a business with only a Facebook page as social-only', () => {
    const d = normalizeRawBusiness(raw({ socials: ['https://facebook.com/abc'] }), meta)!
    expect(d.websiteUrl).toBeNull()
    expect(d.websiteIsSocialOnly).toBe(true)
  })

  it('does not treat an aggregator listing as the business website', () => {
    const d = normalizeRawBusiness(raw({ website: 'https://abc.business.site' }), meta)!
    expect(d.websiteUrl).toBeNull()
  })

  it('never invents a rating or review count', () => {
    const d = normalizeRawBusiness(raw({}), meta)!
    expect(d.rating).toBeNull()
    expect(d.reviewCount).toBeNull()
  })

  it('discards an out-of-range rating rather than clamping it', () => {
    const d = normalizeRawBusiness(raw({ rating: 9.5 }), meta)!
    expect(d.rating).toBeNull()
  })

  it('lowers contact confidence when the phone country could not be inferred', () => {
    const known = normalizeRawBusiness(
      raw({ phones: ['0161 234 5678'], countryCode: 'GB' }),
      meta,
    )!
    const unknown = normalizeRawBusiness(raw({ phones: ['0161 234 5678'] }), meta)!
    const knownPhone = known.contacts.find((c) => c.kind === 'PHONE')!
    const unknownPhone = unknown.contacts.find((c) => c.kind === 'PHONE')!
    expect(unknownPhone.confidence).toBeLessThan(knownPhone.confidence)
  })

  it('deduplicates repeated phone numbers within one record', () => {
    const d = normalizeRawBusiness(
      raw({ phones: ['+44 161 234 5678', '+441612345678'], countryCode: 'GB' }),
      meta,
    )!
    expect(d.contacts.filter((c) => c.kind === 'PHONE')).toHaveLength(1)
  })

  it('retains the raw provider payload as provenance', () => {
    const payload = { id: 'x', foo: 'bar' }
    const d = normalizeRawBusiness(raw({ raw: payload }), meta)!
    expect(d.raw).toEqual(payload)
  })
})

describe('mock provider (§21)', () => {
  const provider = new MockProvider()

  const query = {
    term: 'dentist',
    isExpanded: false,
    originTerm: 'dentist',
    cell: {
      index: 0, lat: 53.48, lng: -2.24, radiusMeters: 2000,
      bbox: { minLat: 53.4, minLng: -2.3, maxLat: 53.5, maxLng: -2.2 },
    },
    location: { city: 'Manchester', countryCode: 'GB' },
    exclusions: [],
    limit: 20,
  }

  const ctx = {
    workspaceId: 'w', jobId: 'j',
    recordUsage: async () => {},
    log: () => {},
  }

  it('is flagged as demo so every record it creates is labelled', () => {
    expect(provider.isDemo).toBe(true)
  })

  it('is deterministic for the same query', async () => {
    const a = await provider.search(query, ctx)
    const b = await provider.search(query, ctx)
    expect(a.map((x) => x.name)).toEqual(b.map((x) => x.name))
  })

  it('includes businesses with no website, so the pipeline has gaps to find', async () => {
    const results = await provider.search(query, ctx)
    expect(results.some((r) => !r.website)).toBe(true)
    expect(results.some((r) => r.website)).toBe(true)
  })

  it('respects the requested limit', async () => {
    const results = await provider.search({ ...query, limit: 5 }, ctx)
    expect(results.length).toBeLessThanOrEqual(5)
  })
})

describe('export columns (§9)', () => {
  it('falls back to the default set when nothing is chosen', () => {
    expect(resolveColumns([]).length).toBeGreaterThan(5)
  })

  it('ignores unknown column ids rather than failing the export', () => {
    const cols = resolveColumns(['name', 'not_a_column'])
    expect(cols.map((c) => c.id)).toEqual(['name'])
  })

  it('renders missing values as "Not Found" (§1)', () => {
    const col = EXPORT_COLUMNS.find((c) => c.id === 'primaryEmail')!
    const row = { primaryEmail: null, contacts: [], sources: [], opportunities: [], tags: [] }
    expect(cellValue(col, row as never)).toBe('Not Found')
  })

  it('marks demo records in the exported file', () => {
    const col = EXPORT_COLUMNS.find((c) => c.id === 'isDemo')!
    const demo = { isDemo: true, contacts: [], sources: [], opportunities: [], tags: [] }
    const live = { isDemo: false, contacts: [], sources: [], opportunities: [], tags: [] }
    expect(cellValue(col, demo as never)).toBe('DEMO DATA')
    expect(cellValue(col, live as never)).toBe('Live')
  })

  it('summarises triggered opportunities with their reasons', () => {
    const col = EXPORT_COLUMNS.find((c) => c.id === 'auditReasons')!
    const row = {
      contacts: [], sources: [], tags: [],
      opportunities: [
        { kind: 'SEO', triggered: true, score: 86, reasons: [{ label: '11 SEO issues' }] },
        { kind: 'SPEED', triggered: false, score: 10, reasons: [] },
      ],
    }
    const value = String(cellValue(col, row as never))
    expect(value).toContain('SEO (86/100)')
    expect(value).toContain('11 SEO issues')
    expect(value).not.toContain('Speed')
  })
})
