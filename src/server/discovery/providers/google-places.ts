import 'server-only'
import { httpJson, HttpError, RateLimiter } from '@/server/http/client'
import { getConnectionSecret, requireConnectionSecret } from '@/server/settings/connections'
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
 * Google Places API (New) — Text Search.
 *
 * Uses the official API with an explicit field mask (which is also what
 * determines the SKU billed). No scraping of maps.google.com: that would breach
 * the terms this file exists to respect (§30).
 *
 * Note on coverage: Text Search returns at most 20 results per page and 3 pages
 * (60 total) per query. That cap is precisely why the tiling engine exists.
 */

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.businessStatus',
  'places.googleMapsUri',
  'nextPageToken',
].join(',')

interface PlacesResponse {
  places?: Array<{
    id?: string
    displayName?: { text?: string }
    formattedAddress?: string
    addressComponents?: Array<{
      longText?: string
      shortText?: string
      types?: string[]
    }>
    location?: { latitude?: number; longitude?: number }
    rating?: number
    userRatingCount?: number
    websiteUri?: string
    nationalPhoneNumber?: string
    internationalPhoneNumber?: string
    primaryTypeDisplayName?: { text?: string }
    types?: string[]
    businessStatus?: string
    googleMapsUri?: string
  }>
  nextPageToken?: string
}

const limiter = new RateLimiter(8)

interface AddressComponent {
  longText?: string
  shortText?: string
  types?: string[]
}

function component(
  components: AddressComponent[] | undefined,
  type: string,
  short = false,
): string | null {
  if (!components) return null
  const hit = components.find((c) => c.types?.includes(type))
  if (!hit) return null
  return (short ? hit.shortText : hit.longText) ?? null
}

export class GooglePlacesProvider implements DiscoveryProvider {
  readonly id = 'google-places'
  readonly label = 'Google Places'
  readonly description =
    'Official Places API (New) Text Search. Strong coverage of ratings, reviews and phone numbers.'
  readonly isDemo = false
  readonly termsUrl = 'https://cloud.google.com/maps-platform/terms'

  async configured(workspaceId?: string): Promise<ProviderStatus> {
    const apiKey = await getConnectionSecret(workspaceId, 'google-places', 'apiKey')
    if (!apiKey) {
      return {
        state: 'NOT_CONFIGURED',
        detail: 'Add a Google Places API key in Settings > Connections and enable the Places API (New) in Google Cloud.',
      }
    }
    // A single 1-result probe verifies the key and that the API is enabled.
    try {
      await httpJson(ENDPOINT, {
        method: 'POST',
        headers: this.headers(apiKey, 'places.id'),
        body: JSON.stringify({ textQuery: 'cafe', pageSize: 1 }),
        timeoutMs: 10_000,
        retries: 0,
      })
      return { state: 'CONNECTED', detail: 'Places API (New) responded successfully.' }
    } catch (err) {
      const detail =
        err instanceof HttpError
          ? `Places API returned ${err.status}. ${err.status === 403 ? 'Check that the Places API (New) is enabled and the key is unrestricted for this server.' : ''}`
          : `Could not reach the Places API: ${(err as Error).message}`
      return { state: 'ERROR', detail }
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
      email: false,
      categories: true,
      openingStatus: true,
      storesProviderId: true,
      maxResultsPerQuery: 60,
    }
  }

  estimateCost(query: DiscoveryQuery): CostEstimate {
    // Text Search bills per request; up to 3 paged requests per query.
    const pages = Math.min(3, Math.ceil(query.limit / 20))
    return {
      requests: pages,
      note: 'Places API (New) Text Search — Enterprise SKU, billed per request.',
    }
  }

  private headers(apiKey: string, mask = FIELD_MASK): Record<string, string> {
    return {
      'content-type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': mask,
    }
  }

  async search(
    query: DiscoveryQuery,
    ctx: ProviderRunContext,
  ): Promise<RawBusiness[]> {
    const apiKey = await requireConnectionSecret(
      ctx.workspaceId,
      'google-places',
      'apiKey',
      'Google Places API key',
    )

    const out: RawBusiness[] = []
    let pageToken: string | undefined
    const maxPages = Math.min(3, Math.ceil(query.limit / 20))

    for (let page = 0; page < maxPages; page++) {
      await limiter.acquire(this.id)

      const body: Record<string, unknown> = {
        textQuery: query.term,
        pageSize: Math.min(20, query.limit),
        locationBias: {
          circle: {
            center: { latitude: query.cell.lat, longitude: query.cell.lng },
            radius: Math.min(50_000, query.cell.radiusMeters),
          },
        },
      }
      if (query.location.countryCode) {
        body.regionCode = query.location.countryCode.toUpperCase()
      }
      if (pageToken) body.pageToken = pageToken

      const data = await httpJson<PlacesResponse>(ENDPOINT, {
        method: 'POST',
        headers: this.headers(apiKey),
        body: JSON.stringify(body),
        timeoutMs: 25_000,
        signal: ctx.signal,
      })
      await ctx.recordUsage('places.searchText', 1)

      for (const p of data.places ?? []) {
        const name = p.displayName?.text?.trim()
        if (!name) continue

        const components = p.addressComponents
        out.push({
          providerId: p.id ?? null,
          sourceUrl: p.googleMapsUri ?? null,
          name,
          website: p.websiteUri ?? null,
          phones: [p.internationalPhoneNumber, p.nationalPhoneNumber].filter(
            (v): v is string => Boolean(v),
          ),
          addressLine: p.formattedAddress ?? null,
          city:
            component(components, 'postal_town') ??
            component(components, 'locality') ??
            null,
          region: component(components, 'administrative_area_level_1') ?? null,
          postalCode: component(components, 'postal_code') ?? null,
          country: component(components, 'country') ?? null,
          countryCode: component(components, 'country', true) ?? null,
          area:
            component(components, 'sublocality') ??
            component(components, 'neighborhood') ??
            null,
          latitude: p.location?.latitude ?? null,
          longitude: p.location?.longitude ?? null,
          category: p.primaryTypeDisplayName?.text ?? p.types?.[0] ?? null,
          categories: p.types ?? [],
          rating: p.rating ?? null,
          reviewCount: p.userRatingCount ?? null,
          openingStatus: p.businessStatus ?? null,
          raw: p,
          // Google is a high-trust source for name/phone/location.
          confidence: 90,
        })
      }

      pageToken = data.nextPageToken
      if (!pageToken || out.length >= query.limit) break
      // Google requires a short pause before a page token becomes valid.
      await new Promise((r) => setTimeout(r, 2_000))
    }

    return out.slice(0, query.limit)
  }
}
