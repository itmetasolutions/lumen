import 'server-only'
import { httpJson, HttpError, RateLimiter } from '@/server/http/client'
import {
  getConnectionBundle,
  requireConnectionSecret,
} from '@/server/settings/connections'
import { usageToday, recordUsage } from '@/server/usage/record'
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
 * Yelp Fusion — Yelp's own API.
 *
 * Preferred over the SerpApi Yelp engine for two concrete reasons: it returns
 * the website URL and price range that the SerpApi engine leaves null, and it
 * does not consume the shared SerpApi quota.
 *
 * It also exposes `businesses/match`, an endpoint built for exactly the problem
 * of "I know this business's name and address, fill in the rest" — which is what
 * the per-business enrichment uses.
 */

const SEARCH_ENDPOINT = 'https://api.yelp.com/v3/businesses/search'
const MATCH_ENDPOINT = 'https://api.yelp.com/v3/businesses/matches'
const DETAIL_ENDPOINT = 'https://api.yelp.com/v3/businesses'

export const DEFAULT_YELP_DAILY_LIMIT = 500

/** Yelp's documented free-tier ceiling is 5 requests/second. */
const limiter = new RateLimiter(4)

interface YelpBusiness {
  id?: string
  alias?: string
  name?: string
  url?: string
  phone?: string
  display_phone?: string
  review_count?: number
  rating?: number
  price?: string
  is_closed?: boolean
  categories?: Array<{ alias?: string; title?: string }>
  coordinates?: { latitude?: number; longitude?: number }
  location?: {
    address1?: string
    address2?: string
    address3?: string
    city?: string
    state?: string
    zip_code?: string
    country?: string
    display_address?: string[]
  }
  attributes?: { business_url?: string; menu_url?: string }
}

interface YelpSearchResponse {
  businesses?: YelpBusiness[]
  total?: number
  error?: { code?: string; description?: string }
}

async function apiKeyFor(workspaceId: string): Promise<string> {
  return requireConnectionSecret(workspaceId, 'yelp-fusion', 'apiKey', 'Yelp Fusion API key')
}

async function dailyLimitFor(workspaceId: string): Promise<number> {
  const bundle = await getConnectionBundle(workspaceId, 'yelp-fusion')
  const raw = bundle.config.dailyLimit
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_YELP_DAILY_LIMIT
}

/**
 * Yelp's free tier is a hard daily allowance. Checking locally means a run stops
 * with a clear message rather than every remaining call returning 429.
 */
export async function assertYelpQuota(workspaceId: string): Promise<void> {
  const limit = await dailyLimitFor(workspaceId)
  if (limit === 0) return
  const used = await usageToday(workspaceId, 'yelp-fusion')
  if (used >= limit) {
    throw new Error(
      `Yelp Fusion daily limit reached (${used}/${limit}). It resets at midnight UTC, or raise the cap in Settings → Connections.`,
    )
  }
}

function toRawBusiness(b: YelpBusiness): RawBusiness | null {
  const name = b.name?.trim()
  if (!name) return null

  const categories = (b.categories ?? [])
    .map((c) => c.title?.trim())
    .filter((t): t is string => Boolean(t))

  const line = [b.location?.address1, b.location?.address2, b.location?.address3]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(' ')

  return {
    providerId: b.id ?? b.alias ?? null,
    // The Yelp listing page, not the business's own site — recorded as
    // provenance, never mistaken for their website.
    sourceUrl: b.url ?? null,
    name,
    // `attributes.business_url` is the business's own site when Yelp has it.
    website: b.attributes?.business_url ?? null,
    phones: [b.phone, b.display_phone].filter((p): p is string => Boolean(p)),
    addressLine: line || b.location?.display_address?.[0] || null,
    city: b.location?.city ?? null,
    region: b.location?.state ?? null,
    postalCode: b.location?.zip_code ?? null,
    country: b.location?.country ?? null,
    countryCode: b.location?.country ?? null,
    latitude: b.coordinates?.latitude ?? null,
    longitude: b.coordinates?.longitude ?? null,
    category: categories[0] ?? null,
    categories,
    rating: typeof b.rating === 'number' ? b.rating : null,
    reviewCount: typeof b.review_count === 'number' ? b.review_count : null,
    openingStatus: b.is_closed === true ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
    raw: b,
    // Yelp is authoritative for its own listing data.
    confidence: 85,
  }
}

/** Price range is not part of RawBusiness; surfaced separately for enrichment. */
export function priceRangeOf(b: YelpBusiness): string | null {
  return b.price?.trim() || null
}

export class YelpFusionProvider implements DiscoveryProvider {
  readonly id = 'yelp-fusion'
  readonly label = 'Yelp Fusion'
  readonly description =
    "Yelp's official API. Returns website URLs and price range that the SerpApi Yelp engine omits, and does not consume the SerpApi quota."
  readonly isDemo = false
  readonly termsUrl = 'https://docs.developer.yelp.com/docs/fusion-terms-of-use'

  async configured(workspaceId?: string): Promise<ProviderStatus> {
    if (!workspaceId) {
      return {
        state: 'NOT_CONFIGURED',
        detail: 'Add a Yelp Fusion API key in Settings → Connections.',
      }
    }
    return this.configuredFor(workspaceId)
  }

  /** Workspace-scoped status: the key is stored per workspace. */
  async configuredFor(workspaceId: string): Promise<ProviderStatus> {
    const bundle = await getConnectionBundle(workspaceId, 'yelp-fusion')
    if (bundle.decryptionError) return { state: 'ERROR', detail: bundle.decryptionError }
    if (!bundle.enabled) {
      return { state: 'NOT_CONFIGURED', detail: 'Yelp Fusion is disabled for this workspace.' }
    }

    let key: string
    try {
      key = await apiKeyFor(workspaceId)
    } catch {
      return {
        state: 'NOT_CONFIGURED',
        detail:
          'Add a Yelp Fusion API key in Settings → Connections. Create one free at yelp.com/developers.',
      }
    }

    const limit = await dailyLimitFor(workspaceId)
    const used = await usageToday(workspaceId, 'yelp-fusion')
    const usage = limit > 0 ? `${used}/${limit} calls used today` : `${used} calls today, no local cap`

    try {
      // A minimal probe that validates the key without burning much quota.
      await httpJson<YelpSearchResponse>(
        `${SEARCH_ENDPOINT}?location=London&limit=1`,
        { headers: { authorization: `Bearer ${key}` }, timeoutMs: 12_000, retries: 0 },
      )
      return { state: 'CONNECTED', detail: `Yelp Fusion connected. ${usage}.` }
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        return { state: 'ERROR', detail: 'Yelp rejected the API key (401).' }
      }
      if (err instanceof HttpError && err.status === 429) {
        return { state: 'ERROR', detail: `Yelp daily limit reached. ${usage}.` }
      }
      return { state: 'ERROR', detail: `Yelp Fusion error: ${(err as Error).message}` }
    }
  }

  capabilities(): ProviderCapabilities {
    return {
      radius: true,
      bbox: false,
      ratings: true,
      reviewCounts: true,
      phone: true,
      website: true,
      email: false,
      categories: true,
      openingStatus: true,
      storesProviderId: true,
      maxResultsPerQuery: 50,
    }
  }

  estimateCost(query: DiscoveryQuery): CostEstimate {
    return {
      requests: Math.max(1, Math.ceil(query.limit / 50)),
      estimatedUsd: 0,
      note: 'Free tier: 500 calls/day. Does not consume the SerpApi quota.',
    }
  }

  async search(query: DiscoveryQuery, ctx: ProviderRunContext): Promise<RawBusiness[]> {
    await assertYelpQuota(ctx.workspaceId)
    const key = await apiKeyFor(ctx.workspaceId)
    await limiter.acquire(this.id)

    const params = new URLSearchParams({
      term: query.term,
      latitude: String(query.cell.lat),
      longitude: String(query.cell.lng),
      // Yelp caps radius at 40000 m.
      radius: String(Math.min(40_000, Math.round(query.cell.radiusMeters))),
      limit: String(Math.min(50, Math.max(1, query.limit))),
      sort_by: 'distance',
    })

    const data = await httpJson<YelpSearchResponse>(
      `${SEARCH_ENDPOINT}?${params.toString()}`,
      { headers: { authorization: `Bearer ${key}` }, timeoutMs: 25_000, signal: ctx.signal },
    )
    await ctx.recordUsage('yelp.search', 1)

    if (data.error) {
      throw new Error(`Yelp Fusion: ${data.error.description ?? data.error.code}`)
    }

    return (data.businesses ?? [])
      .map(toRawBusiness)
      .filter((b): b is RawBusiness => b !== null)
      .slice(0, query.limit)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-business lookup, used by enrichment rather than discovery
// ─────────────────────────────────────────────────────────────────────────────

export interface YelpMatch {
  business: RawBusiness
  priceRange: string | null
  yelpUrl: string | null
}

/**
 * Resolves one known business against Yelp.
 *
 * `businesses/matches` exists precisely for this: given a name and address it
 * returns the single best match rather than a search page. A follow-up detail
 * call fills in fields the match response omits.
 */
export async function matchYelpBusiness(input: {
  workspaceId: string
  name: string
  addressLine?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  latitude?: number | null
  longitude?: number | null
}): Promise<YelpMatch | null> {
  await assertYelpQuota(input.workspaceId)
  const key = await apiKeyFor(input.workspaceId)

  // Yelp requires a country code and rejects anything that is not ISO-3166-1.
  const country = (input.country ?? 'US').slice(0, 2).toUpperCase()

  const params = new URLSearchParams({
    name: input.name,
    address1: input.addressLine ?? '',
    city: input.city ?? '',
    state: input.state ?? '',
    country,
    match_threshold: 'default',
    limit: '1',
  })
  if (input.latitude !== null && input.latitude !== undefined) {
    params.set('latitude', String(input.latitude))
  }
  if (input.longitude !== null && input.longitude !== undefined) {
    params.set('longitude', String(input.longitude))
  }

  await limiter.acquire('yelp-fusion')

  let match: YelpSearchResponse
  try {
    match = await httpJson<YelpSearchResponse>(`${MATCH_ENDPOINT}?${params.toString()}`, {
      headers: { authorization: `Bearer ${key}` },
      timeoutMs: 20_000,
      retries: 1,
    })
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return null
    throw err
  }
  await recordUsage({ workspaceId: input.workspaceId, provider: 'yelp-fusion', operation: 'yelp.match' })

  const hit = match.businesses?.[0]
  if (!hit?.id) return null

  // The match response is deliberately thin; the detail call carries price,
  // website attributes and full categories.
  let detail: YelpBusiness = hit
  try {
    await limiter.acquire('yelp-fusion')
    detail = await httpJson<YelpBusiness>(`${DETAIL_ENDPOINT}/${encodeURIComponent(hit.id)}`, {
      headers: { authorization: `Bearer ${key}` },
      timeoutMs: 20_000,
      retries: 1,
    })
    await recordUsage({
      workspaceId: input.workspaceId,
      provider: 'yelp-fusion',
      operation: 'yelp.detail',
    })
  } catch {
    // The match alone is still useful; keep it rather than failing the lookup.
  }

  const business = toRawBusiness(detail)
  if (!business) return null

  return {
    business,
    priceRange: priceRangeOf(detail),
    yelpUrl: detail.url ?? hit.url ?? null,
  }
}
