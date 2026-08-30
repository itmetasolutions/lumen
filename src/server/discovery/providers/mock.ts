import 'server-only'
import type {
  CostEstimate,
  DiscoveryProvider,
  DiscoveryQuery,
  ProviderCapabilities,
  ProviderRunContext,
  ProviderStatus,
  RawBusiness,
} from '../types'

/**
 * Demo provider (§21).
 *
 * Exists so the whole pipeline — discovery, dedupe, audit, scoring, export — can
 * be exercised without any credentials. Everything it emits is flagged
 * `isDemo`, which propagates to BusinessSource.isDemo and Business.isDemo, is
 * rendered as a DEMO DATA badge, and is written into every export.
 *
 * It deliberately produces *some* records with missing websites, missing phones
 * and missing emails, because a demo dataset in which every field is populated
 * would hide exactly the gaps the product is built to find.
 */

const NAME_PREFIXES = [
  'Northgate', 'Riverside', 'Oakfield', 'Kings', 'Bright', 'Summit', 'Elmwood',
  'Harbour', 'Crown', 'Meadow', 'Sterling', 'Pinnacle', 'Cedar', 'Anchor',
  'Willow', 'Granite', 'Lakeview', 'Foxglove', 'Ironbridge', 'Halcyon',
]

const NAME_SUFFIXES = ['& Co', 'Group', 'Practice', 'Services', 'Ltd', 'Partners', '']

const STREETS = [
  'High Street', 'Mill Lane', 'Station Road', 'Church Street', 'Park Avenue',
  'Victoria Road', 'Queens Road', 'Market Square', 'Bridge Street', 'Union Street',
]

/** Deterministic PRNG so repeated demo runs are reproducible and diffable. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export class MockProvider implements DiscoveryProvider {
  readonly id = 'mock'
  readonly label = 'Demo data (no credentials)'
  readonly description =
    'Synthesised businesses for evaluating the pipeline end to end. Every record is permanently marked DEMO DATA and can never be confused with live results.'
  readonly isDemo = true

  async configured(): Promise<ProviderStatus> {
    return {
      state: 'CONNECTED',
      detail: 'Always available. Produces clearly-labelled synthetic records only.',
    }
  }

  capabilities(): ProviderCapabilities {
    return {
      radius: true,
      bbox: true,
      ratings: true,
      reviewCounts: true,
      phone: true,
      website: true,
      email: true,
      categories: true,
      openingStatus: true,
      storesProviderId: true,
      maxResultsPerQuery: 60,
    }
  }

  estimateCost(): CostEstimate {
    return { requests: 0, estimatedUsd: 0, note: 'No external calls.' }
  }

  async search(
    query: DiscoveryQuery,
    _ctx: ProviderRunContext,
  ): Promise<RawBusiness[]> {
    const seed = hashString(
      `${query.term}|${query.cell.lat.toFixed(3)}|${query.cell.lng.toFixed(3)}`,
    )
    const rand = mulberry32(seed)
    const count = Math.min(query.limit, 8 + Math.floor(rand() * 12))
    const out: RawBusiness[] = []

    const industry = query.term.replace(/\b(company|services|near me|local)\b/g, '').trim()
    const label = industry.charAt(0).toUpperCase() + industry.slice(1)

    for (let i = 0; i < count; i++) {
      const prefix = NAME_PREFIXES[Math.floor(rand() * NAME_PREFIXES.length)]!
      const suffix = NAME_SUFFIXES[Math.floor(rand() * NAME_SUFFIXES.length)]!
      const name = `${prefix} ${label} ${suffix}`.replace(/\s+/g, ' ').trim()
      const slug = `${prefix}-${label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')

      // ~28% have no website at all — the Website Creation cohort.
      const hasWebsite = rand() > 0.28
      // ~35% of the rest publish an email.
      const hasEmail = rand() > 0.65
      const hasPhone = rand() > 0.12

      const latJitter = (rand() - 0.5) * (query.cell.radiusMeters / 111_320) * 1.6
      const lngJitter = (rand() - 0.5) * (query.cell.radiusMeters / 111_320) * 1.6

      out.push({
        providerId: `mock_${seed}_${i}`,
        sourceUrl: null,
        name,
        website: hasWebsite ? `https://${slug}.example.com` : null,
        phones: hasPhone
          ? [`+44 161 ${String(200 + Math.floor(rand() * 799))} ${String(1000 + Math.floor(rand() * 8999))}`]
          : [],
        emails: hasEmail ? [`hello@${slug}.example.com`] : [],
        socials: rand() > 0.6 ? [`https://facebook.com/${slug}`] : [],
        addressLine: `${1 + Math.floor(rand() * 180)} ${STREETS[Math.floor(rand() * STREETS.length)]}`,
        city: query.location.city ?? null,
        region: query.location.region ?? null,
        postalCode: query.location.postalCode ?? null,
        country: query.location.country ?? null,
        countryCode: query.location.countryCode ?? null,
        area: query.location.area ?? null,
        latitude: query.cell.lat + latJitter,
        longitude: query.cell.lng + lngJitter,
        category: label,
        categories: [label],
        // Some businesses genuinely have no reviews; reflect that.
        rating: rand() > 0.15 ? Math.round((3.1 + rand() * 1.9) * 10) / 10 : null,
        reviewCount: rand() > 0.15 ? Math.floor(rand() * 420) : null,
        openingStatus: rand() > 0.05 ? 'OPERATIONAL' : 'CLOSED_TEMPORARILY',
        raw: { demo: true, term: query.term, cell: query.cell.index },
        confidence: 40,
      })
    }

    return out
  }
}
