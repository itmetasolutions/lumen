import 'server-only'
import { env } from '@/server/env'
import { httpRequest, RateLimiter } from '@/server/http/client'
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
 * OpenStreetMap via the Overpass API.
 *
 * Important for this product: it requires no API key, so the platform is
 * genuinely functional out of the box with *real* data rather than only mock
 * data. ODbL requires attribution, which the UI carries on every OSM-sourced row.
 *
 * Overpass is a shared community resource. We rate-limit hard (1 request every
 * 1.5s), set an identifying User-Agent, and cap query size — the public endpoint
 * is not something to hammer (§30).
 */

const limiter = new RateLimiter(0.66, 1)

/** Industry term → OSM tag filters. Falls back to a name regex when unmapped. */
const TAG_MAP: Record<string, string[]> = {
  dentist: ['"amenity"="dentist"', '"healthcare"="dentist"'],
  doctor: ['"amenity"="doctors"', '"healthcare"="doctor"'],
  pharmacy: ['"amenity"="pharmacy"'],
  vet: ['"amenity"="veterinary"'],
  veterinarian: ['"amenity"="veterinary"'],
  restaurant: ['"amenity"="restaurant"'],
  cafe: ['"amenity"="cafe"'],
  bar: ['"amenity"="bar"'],
  pub: ['"amenity"="pub"'],
  bakery: ['"shop"="bakery"'],
  butcher: ['"shop"="butcher"'],
  hairdresser: ['"shop"="hairdresser"'],
  salon: ['"shop"="hairdresser"', '"shop"="beauty"'],
  barber: ['"shop"="hairdresser"'],
  florist: ['"shop"="florist"'],
  optician: ['"shop"="optician"'],
  gym: ['"leisure"="fitness_centre"'],
  hotel: ['"tourism"="hotel"', '"tourism"="guest_house"'],
  lawyer: ['"office"="lawyer"'],
  solicitor: ['"office"="lawyer"'],
  accountant: ['"office"="accountant"'],
  architect: ['"office"="architect"'],
  'estate agent': ['"office"="estate_agent"'],
  'insurance broker': ['"office"="insurance"'],
  'travel agent': ['"shop"="travel_agency"'],
  plumber: ['"craft"="plumber"', '"shop"="plumber"'],
  electrician: ['"craft"="electrician"'],
  builder: ['"craft"="builder"'],
  carpenter: ['"craft"="carpenter"'],
  joiner: ['"craft"="carpenter"'],
  roofer: ['"craft"="roofer"'],
  painter: ['"craft"="painter"'],
  locksmith: ['"craft"="locksmith"', '"shop"="locksmith"'],
  photographer: ['"craft"="photographer"', '"shop"="photo"'],
  'car repair': ['"shop"="car_repair"'],
  'car dealer': ['"shop"="car"'],
  garage: ['"shop"="car_repair"'],
  nursery: ['"amenity"="kindergarten"', '"amenity"="childcare"'],
  'driving school': ['"amenity"="driving_school"'],
  physiotherapist: ['"healthcare"="physiotherapist"'],
  chiropractor: ['"healthcare"="chiropractor"'],
  'pet groomer': ['"shop"="pet_grooming"'],
  cleaner: ['"shop"="laundry"', '"shop"="dry_cleaning"'],
  printer: ['"shop"="copyshop"'],
  tattoo: ['"shop"="tattoo"'],
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

interface OverpassResponse {
  elements?: OverpassElement[]
}

function singular(term: string): string {
  if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`
  if (term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
  return term
}

/** Escape a user term before it enters an Overpass regex literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')
}

export class OpenStreetMapProvider implements DiscoveryProvider {
  readonly id = 'openstreetmap'
  readonly label = 'OpenStreetMap'
  readonly description =
    'Overpass API over OpenStreetMap. No API key required. Excellent for addresses, websites and phone numbers; carries no ratings or review counts.'
  readonly isDemo = false
  readonly termsUrl = 'https://www.openstreetmap.org/copyright'

  async configured(): Promise<ProviderStatus> {
    try {
      const res = await httpRequest(env.overpassEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'user-agent': env.crawlerUserAgent,
        },
        body: '[out:json][timeout:10];node["amenity"="cafe"](51.50,-0.13,51.51,-0.12);out 1;',
        timeoutMs: 20_000,
        retries: 0,
      })
      if (!res.ok) {
        return {
          state: 'ERROR',
          detail: `Overpass endpoint returned ${res.status}. The public endpoint is often busy; try again or set OVERPASS_ENDPOINT to a mirror.`,
        }
      }
      return {
        state: 'CONNECTED',
        detail: 'Overpass API reachable. Data © OpenStreetMap contributors (ODbL).',
      }
    } catch (err) {
      return {
        state: 'ERROR',
        detail: `Could not reach Overpass: ${(err as Error).message}`,
      }
    }
  }

  capabilities(): ProviderCapabilities {
    return {
      radius: true,
      bbox: true,
      ratings: false,
      reviewCounts: false,
      phone: true,
      website: true,
      email: true,
      categories: true,
      openingStatus: false,
      storesProviderId: true,
      maxResultsPerQuery: 500,
    }
  }

  estimateCost(): CostEstimate {
    return { requests: 1, estimatedUsd: 0, note: 'Free community endpoint; rate-limited by us to stay within fair use.' }
  }

  private buildQuery(query: DiscoveryQuery): string {
    const term = query.term.toLowerCase().trim()
    const tags = TAG_MAP[term] ?? TAG_MAP[singular(term)]
    const { lat, lng, radiusMeters } = query.cell
    const around = `(around:${Math.round(radiusMeters)},${lat.toFixed(6)},${lng.toFixed(6)})`

    const clauses: string[] = []
    if (tags) {
      for (const t of tags) clauses.push(`nwr[${t}]${around};`)
    } else {
      // Unmapped term: match the business name, and require it to be *some* kind
      // of business so we do not return bus stops and park benches.
      const rx = escapeRegex(term)
      for (const kind of ['shop', 'craft', 'office', 'amenity', 'healthcare']) {
        clauses.push(`nwr["name"~"${rx}",i]["${kind}"]${around};`)
      }
    }

    return `[out:json][timeout:60];(${clauses.join('')});out center tags ${Math.min(500, query.limit)};`
  }

  async search(
    query: DiscoveryQuery,
    ctx: ProviderRunContext,
  ): Promise<RawBusiness[]> {
    await limiter.acquire(this.id)

    const ql = this.buildQuery(query)
    const res = await httpRequest(env.overpassEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'user-agent': env.crawlerUserAgent,
      },
      body: ql,
      timeoutMs: 90_000,
      retries: 1,
      signal: ctx.signal,
    })
    await ctx.recordUsage('overpass.query', 1)

    if (!res.ok) {
      throw new Error(`Overpass returned ${res.status} (endpoint busy or query too large)`)
    }

    const data = (await res.json()) as OverpassResponse
    const out: RawBusiness[] = []

    for (const el of data.elements ?? []) {
      const tags = el.tags ?? {}
      const name = tags.name?.trim()
      // An unnamed node is not a lead.
      if (!name) continue

      const lat = el.lat ?? el.center?.lat ?? null
      const lon = el.lon ?? el.center?.lon ?? null

      const categoryTag =
        tags.shop ?? tags.craft ?? tags.office ?? tags.amenity ?? tags.healthcare ?? null

      const addressLine = [tags['addr:housenumber'], tags['addr:street']]
        .filter(Boolean)
        .join(' ')

      const socials = [
        tags['contact:facebook'],
        tags['contact:instagram'],
        tags['contact:twitter'],
        tags['contact:linkedin'],
      ].filter((v): v is string => Boolean(v))

      out.push({
        providerId: `${el.type}/${el.id}`,
        sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        name,
        website: tags.website ?? tags['contact:website'] ?? tags.url ?? null,
        phones: [tags.phone, tags['contact:phone'], tags['contact:mobile']].filter(
          (v): v is string => Boolean(v),
        ),
        emails: [tags.email, tags['contact:email']].filter((v): v is string =>
          Boolean(v),
        ),
        socials,
        addressLine: addressLine || null,
        city: tags['addr:city'] ?? null,
        region: tags['addr:state'] ?? tags['addr:province'] ?? null,
        postalCode: tags['addr:postcode'] ?? null,
        country: tags['addr:country'] ?? null,
        countryCode: tags['addr:country'] ?? null,
        area: tags['addr:suburb'] ?? tags['addr:neighbourhood'] ?? null,
        latitude: lat,
        longitude: lon,
        category: categoryTag,
        categories: Object.entries(tags)
          .filter(([k]) => ['shop', 'craft', 'office', 'amenity', 'healthcare', 'cuisine'].includes(k))
          .map(([k, v]) => `${k}=${v}`),
        // OSM has no ratings — leave null rather than defaulting to 0 (§1).
        rating: null,
        reviewCount: null,
        openingStatus: null,
        raw: el,
        // Community-maintained: excellent addresses, occasionally stale contacts.
        confidence: 72,
      })
    }

    return out.slice(0, query.limit)
  }
}
