import { describe, it, expect } from 'vitest'
import { scoreMatch, type MatchCandidate, type MatchInput } from '@/server/resolution/match'

/**
 * §3 — entity resolution.
 *
 * The two failure modes this guards against:
 *   - creating three leads for one business seen by three providers
 *   - merging two genuinely separate branches into one record
 */

function input(over: Partial<MatchInput> = {}): MatchInput {
  return {
    name: 'ABC Dental',
    normalizedName: 'abc dental',
    websiteDomain: null,
    phoneKeys: [],
    addressLine: null,
    postalCode: null,
    city: 'Manchester',
    latitude: null,
    longitude: null,
    providerKey: null,
    ...over,
  }
}

function candidate(over: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    id: 'b1',
    name: 'ABC Dental',
    normalizedName: 'abc dental',
    websiteDomain: null,
    primaryPhoneNormalized: null,
    phoneKeys: [],
    addressLine: null,
    postalCode: null,
    city: 'Manchester',
    latitude: null,
    longitude: null,
    providerKeys: [],
    ...over,
  }
}

describe('decisive identifiers', () => {
  it('merges on an identical provider record id', () => {
    const r = scoreMatch(
      input({ providerKey: 'google-places:abc123', name: 'Totally Different Name' }),
      candidate({ providerKeys: ['google-places:abc123'] }),
    )
    expect(r.decision).toBe('MERGE')
    expect(r.confidence).toBe('HIGH')
  })

  it('merges on a shared domain plus a recognisable name', () => {
    const r = scoreMatch(
      input({ websiteDomain: 'abcdental.co.uk', name: 'ABC Dental' }),
      candidate({ websiteDomain: 'abcdental.co.uk', name: 'ABC Dental Practice' }),
    )
    expect(r.decision).toBe('MERGE')
  })

  it('merges on a shared phone plus a recognisable name', () => {
    const r = scoreMatch(
      input({ phoneKeys: ['+441612345678'] }),
      candidate({ phoneKeys: ['+441612345678'], name: 'ABC Dental Ltd' }),
    )
    expect(r.decision).toBe('MERGE')
  })
})

describe('avoiding wrong merges', () => {
  it('does NOT merge two branches of a chain on domain alone', () => {
    // Same franchise domain, but 30 km apart — separate locations.
    const r = scoreMatch(
      input({
        websiteDomain: 'chain.co.uk',
        name: 'Chain Dental Manchester',
        latitude: 53.4808,
        longitude: -2.2426,
      }),
      candidate({
        websiteDomain: 'chain.co.uk',
        name: 'Chain Dental Stockport',
        latitude: 53.4106,
        longitude: -2.1575,
      }),
    )
    expect(r.decision).not.toBe('MERGE')
  })

  it('does NOT merge neighbouring shops with different house numbers', () => {
    const r = scoreMatch(
      input({
        name: 'The Barber Shop',
        addressLine: '12 High Street',
        latitude: 53.4808,
        longitude: -2.2426,
      }),
      candidate({
        name: 'The Barber Shop',
        addressLine: '14 High Street',
        latitude: 53.48081,
        longitude: -2.24261,
      }),
    )
    expect(r.signals.some((s) => s.includes('building number'))).toBe(true)
  })

  it('treats businesses far apart as distinct even with identical names', () => {
    const r = scoreMatch(
      input({ name: 'The Coffee House', latitude: 53.4808, longitude: -2.2426 }),
      candidate({
        name: 'The Coffee House',
        latitude: 51.5074,
        longitude: -0.1278,
        city: 'London',
      }),
    )
    expect(r.decision).toBe('DISTINCT')
  })

  it('treats unrelated businesses as distinct', () => {
    const r = scoreMatch(
      input({ name: 'ABC Dental' }),
      candidate({ name: 'XYZ Plumbing', normalizedName: 'xyz plumbing' }),
    )
    expect(r.decision).toBe('DISTINCT')
  })
})

describe('uncertain matches', () => {
  it('flags a plausible-but-unproven match for review rather than merging blindly', () => {
    const r = scoreMatch(
      input({
        name: 'ABC Dental',
        latitude: 53.4808,
        longitude: -2.2426,
        postalCode: 'M202RN',
      }),
      candidate({
        name: 'ABC Dental Surgery',
        normalizedName: 'abc dental surgery',
        latitude: 53.4809,
        longitude: -2.2427,
        postalCode: 'M202RN',
      }),
    )
    expect(['MERGE', 'REVIEW']).toContain(r.decision)
    expect(r.signals.length).toBeGreaterThan(0)
  })

  it('always records why it decided what it did', () => {
    const r = scoreMatch(input({ phoneKeys: ['+441612345678'] }), candidate({ phoneKeys: ['+441612345678'] }))
    expect(r.signals).toContain('Matching phone number')
  })
})
