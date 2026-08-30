import 'server-only'
import { httpJson, HttpError, RateLimiter } from '@/server/http/client'
import { normalizeUrl } from '@/server/normalize/url'
import { usageThisMonth } from '@/server/usage/record'
import {
  getConnectionBundle,
  getConnectionSecret,
  requireConnectionSecret,
} from '@/server/settings/connections'
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
 * Licensed SERP provider adapters.
 *
 * These adapters call SerpApi's supported API endpoints. They do not automate
 * Google Maps, Google Search, Yelp, or Yandex browser pages.
 */

export const SERPAPI_DISCOVERY_PROVIDER_IDS = [
  'search',
  'serpapi-yelp',
  'serpapi-yandex',
] as const

export const DEFAULT_SERPAPI_MONTHLY_LIMIT = 250

const SEARCH_ENDPOINT = 'https://serpapi.com/search.json'
const ACCOUNT_ENDPOINT = 'https://serpapi.com/account.json'
const limiter = new RateLimiter(2)

interface SerpApiAccount {
  error?: string
  searches_per_month?: number
  plan_searches_left?: number
  total_searches_left?: number
  this_month_usage?: number
  plan_renewal_date?: string | null
}

export interface SerpApiQuotaStatus {
  configuredLimit: number
  localUsed: number
  localLeft: number | null
  remoteLimit: number | null
  remoteUsed: number | null
  remoteLeft: number | null
  renewalDate: string | null
  full: boolean
  remoteError: string | null
  detail: string
}

interface SerpApiLocalResult {
  position?: number
  title?: string
  place_id?: string
  data_id?: string
  data_cid?: string
  link?: string
  gps_coordinates?: { latitude?: number; longitude?: number }
  rating?: number
  reviews?: number
  type?: string
  types?: string[]
  address?: string
  phone?: string
  website?: string
  business_status?: string
}

interface SerpApiMapsResponse {
  error?: string
  local_results?: SerpApiLocalResult[]
  place_results?: SerpApiLocalResult
}

interface SerpApiYelpResult {
  title?: string
  link?: string
  place_id?: string
  place_ids?: string[]
  rating?: number
  reviews?: number
  phone?: string
  address?: string
  neighborhoods?: string | string[]
  categories?: Array<{ title?: string; link?: string }>
}

interface SerpApiYelpResponse {
  error?: string
  organic_results?: SerpApiYelpResult[]
}

interface SerpApiOrganicResult {
  position?: number
  title?: string
  link?: string
  displayed_link?: string
  snippet?: string
}

interface SerpApiOrganicResponse {
  error?: string
  organic_results?: SerpApiOrganicResult[]
}

abstract class SerpApiProvider implements DiscoveryProvider {
  readonly isDemo = false
  readonly termsUrl = 'https://serpapi.com/legal'

  abstract readonly id: string
  abstract readonly label: string
  abstract readonly description: string
  protected abstract readonly operation: string
  protected abstract readonly maxResultsPerQuery: number

  async configured(workspaceId?: string): Promise<ProviderStatus> {
    return serpApiProviderStatus(workspaceId)
  }

  estimateCost(query: DiscoveryQuery): CostEstimate {
    return {
      requests: Math.max(1, Math.ceil(query.limit / this.maxResultsPerQuery)),
      note: 'One SerpApi search per query per geo cell. All SerpApi engines share the same monthly cap.',
    }
  }

  protected async apiKey(ctx: ProviderRunContext): Promise<string> {
    const bundle = await getConnectionBundle(ctx.workspaceId, 'search')
    const kind = bundle.config.kind || 'serpapi'
    if (kind !== 'serpapi') {
      throw new Error('SerpApi discovery engines require Provider kind = SerpApi in Settings > Connections.')
    }
    await assertSerpApiQuota(ctx.workspaceId)
    return requireConnectionSecret(ctx.workspaceId, 'search', 'apiKey', 'SerpApi API key')
  }

  protected async fetch<T>(
    ctx: ProviderRunContext,
    params: URLSearchParams,
  ): Promise<T> {
    const apiKey = await this.apiKey(ctx)
    params.set('api_key', apiKey)
    await limiter.acquire(this.id)
    const data = await httpJson<T>(`${SEARCH_ENDPOINT}?${params.toString()}`, {
      timeoutMs: 30_000,
      signal: ctx.signal,
    })
    await ctx.recordUsage(this.operation, 1)
    return data
  }

  abstract capabilities(): ProviderCapabilities
  abstract search(query: DiscoveryQuery, ctx: ProviderRunContext): Promise<RawBusiness[]>
}

export class SearchProvider extends SerpApiProvider {
  readonly id = 'search'
  readonly label = 'SerpApi Google Maps'
  readonly description =
    'SerpApi Google Maps engine for local business listings, ratings, reviews, phone numbers and websites.'
  protected readonly operation = 'serpapi.google_maps'
  protected readonly maxResultsPerQuery = 20

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
      maxResultsPerQuery: this.maxResultsPerQuery,
    }
  }

  async search(
    query: DiscoveryQuery,
    ctx: ProviderRunContext,
  ): Promise<RawBusiness[]> {
    const zoom = radiusToZoom(query.cell.radiusMeters)
    const params = new URLSearchParams({
      engine: 'google_maps',
      type: 'search',
      q: query.term,
      ll: `@${query.cell.lat.toFixed(6)},${query.cell.lng.toFixed(6)},${zoom}z`,
    })
    if (query.location.countryCode) {
      params.set('gl', query.location.countryCode.toLowerCase())
    }

    const data = await this.fetch<SerpApiMapsResponse>(ctx, params)
    if (data.error) throw new Error(`SerpApi Google Maps: ${data.error}`)

    const results = data.local_results ?? (data.place_results ? [data.place_results] : [])

    return results
      .filter((r) => Boolean(r.title?.trim()))
      .slice(0, query.limit)
      .map<RawBusiness>((r) => ({
        providerId: r.place_id ?? r.data_id ?? r.data_cid ?? null,
        sourceUrl: r.link ?? null,
        name: r.title!.trim(),
        website: r.website ?? null,
        phones: r.phone ? [r.phone] : [],
        addressLine: r.address ?? null,
        city: query.location.city ?? null,
        region: query.location.region ?? null,
        postalCode: null,
        country: query.location.country ?? null,
        countryCode: query.location.countryCode ?? null,
        latitude: r.gps_coordinates?.latitude ?? null,
        longitude: r.gps_coordinates?.longitude ?? null,
        category: r.type ?? r.types?.[0] ?? null,
        categories: r.types ?? [],
        rating: r.rating ?? null,
        reviewCount: r.reviews ?? null,
        openingStatus: r.business_status ?? null,
        raw: r,
        confidence: 82,
      }))
  }
}

export class SerpApiYelpProvider extends SerpApiProvider {
  readonly id = 'serpapi-yelp'
  readonly label = 'SerpApi Yelp'
  readonly description =
    'SerpApi Yelp engine for Yelp business search results, ratings, reviews, categories and phone numbers.'
  protected readonly operation = 'serpapi.yelp'
  protected readonly maxResultsPerQuery = 10

  capabilities(): ProviderCapabilities {
    return {
      radius: false,
      bbox: false,
      ratings: true,
      reviewCounts: true,
      phone: true,
      website: false,
      email: false,
      categories: true,
      openingStatus: false,
      storesProviderId: true,
      maxResultsPerQuery: this.maxResultsPerQuery,
    }
  }

  async search(
    query: DiscoveryQuery,
    ctx: ProviderRunContext,
  ): Promise<RawBusiness[]> {
    const location = locationText(query.location)
    if (!location) {
      throw new Error('Yelp search requires a city, region, country or postal code.')
    }

    const bundle = await getConnectionBundle(ctx.workspaceId, 'search')
    const params = new URLSearchParams({
      engine: 'yelp',
      find_desc: query.term,
      find_loc: location,
      yelp_domain: bundle.config.yelpDomain || 'yelp.com',
    })

    const data = await this.fetch<SerpApiYelpResponse>(ctx, params)
    if (data.error) throw new Error(`SerpApi Yelp: ${data.error}`)

    return (data.organic_results ?? [])
      .filter((r) => Boolean(r.title?.trim()))
      .slice(0, query.limit)
      .map<RawBusiness>((r) => {
        const categories = (r.categories ?? [])
          .map((category) => category.title?.trim())
          .filter((value): value is string => Boolean(value))
        return {
          providerId: r.place_id ?? r.place_ids?.join(':') ?? r.link ?? null,
          sourceUrl: r.link ?? null,
          name: r.title!.trim(),
          website: null,
          phones: r.phone ? [r.phone] : [],
          socials: r.link ? [r.link] : [],
          addressLine: r.address ?? null,
          city: query.location.city ?? null,
          region: query.location.region ?? null,
          postalCode: query.location.postalCode ?? null,
          country: query.location.country ?? null,
          countryCode: query.location.countryCode ?? null,
          area: Array.isArray(r.neighborhoods) ? r.neighborhoods[0] ?? null : r.neighborhoods ?? null,
          category: categories[0] ?? query.term,
          categories,
          rating: r.rating ?? null,
          reviewCount: r.reviews ?? null,
          openingStatus: null,
          raw: r,
          confidence: 70,
        }
      })
  }
}

export class SerpApiYandexProvider extends SerpApiProvider {
  readonly id = 'serpapi-yandex'
  readonly label = 'SerpApi Yandex'
  readonly description =
    'SerpApi Yandex search engine results for finding likely business websites when local listing APIs miss them.'
  protected readonly operation = 'serpapi.yandex'
  protected readonly maxResultsPerQuery = 20

  capabilities(): ProviderCapabilities {
    return {
      radius: false,
      bbox: false,
      ratings: false,
      reviewCounts: false,
      phone: false,
      website: true,
      email: false,
      categories: false,
      openingStatus: false,
      storesProviderId: true,
      maxResultsPerQuery: this.maxResultsPerQuery,
    }
  }

  async search(
    query: DiscoveryQuery,
    ctx: ProviderRunContext,
  ): Promise<RawBusiness[]> {
    const bundle = await getConnectionBundle(ctx.workspaceId, 'search')
    const text = [query.term, locationText(query.location)].filter(Boolean).join(' ')
    const params = new URLSearchParams({
      engine: 'yandex',
      text,
      groups_on_page: String(Math.min(this.maxResultsPerQuery, Math.max(1, query.limit))),
      yandex_domain: bundle.config.yandexDomain || 'yandex.com',
      lang: bundle.config.yandexLang || 'en',
    })
    if (bundle.config.yandexLocationId) {
      params.set('lr', bundle.config.yandexLocationId)
    }

    const data = await this.fetch<SerpApiOrganicResponse>(ctx, params)
    if (data.error) throw new Error(`SerpApi Yandex: ${data.error}`)

    return (data.organic_results ?? [])
      .flatMap((r): RawBusiness[] => {
        const site = normalizeUrl(r.link)
        const name = businessNameFromTitle(r.title)
        if (!site || !name || shouldSkipOrganicDomain(site.domain)) return []
        return [{
          providerId: r.link ?? site.href,
          sourceUrl: r.link ?? site.href,
          name,
          website: site.href,
          phones: [],
          emails: [],
          socials: [],
          addressLine: null,
          city: query.location.city ?? null,
          region: query.location.region ?? null,
          postalCode: query.location.postalCode ?? null,
          country: query.location.country ?? null,
          countryCode: query.location.countryCode ?? null,
          category: query.term,
          categories: [],
          rating: null,
          reviewCount: null,
          openingStatus: null,
          raw: r,
          confidence: 48,
        }]
      })
      .slice(0, query.limit)
  }
}

export async function getSerpApiQuotaStatus(
  workspaceId?: string,
): Promise<SerpApiQuotaStatus> {
  const configuredLimit = await getSerpApiMonthlyLimit(workspaceId)
  const localUsed = workspaceId
    ? await usageThisMonth(workspaceId, [...SERPAPI_DISCOVERY_PROVIDER_IDS])
    : 0
  const localLeft =
    configuredLimit > 0 ? Math.max(0, configuredLimit - localUsed) : null

  let remoteLimit: number | null = null
  let remoteUsed: number | null = null
  let remoteLeft: number | null = null
  let renewalDate: string | null = null
  let remoteError: string | null = null

  const apiKey = await getConnectionSecret(workspaceId, 'search', 'apiKey').catch((err) => {
    remoteError = (err as Error).message
    return undefined
  })

  if (apiKey) {
    try {
      const account = await httpJson<SerpApiAccount>(
        `${ACCOUNT_ENDPOINT}?api_key=${encodeURIComponent(apiKey)}`,
        { timeoutMs: 10_000, retries: 0 },
      )
      if (account.error) {
        remoteError = account.error
      } else {
        remoteLimit = finiteInt(account.searches_per_month)
        remoteUsed = finiteInt(account.this_month_usage)
        remoteLeft = finiteInt(account.total_searches_left ?? account.plan_searches_left)
        renewalDate = account.plan_renewal_date ?? null
      }
    } catch (err) {
      remoteError =
        err instanceof HttpError
          ? `SerpApi account check returned ${err.status}.`
          : (err as Error).message
    }
  }

  const full =
    (configuredLimit > 0 && localUsed >= configuredLimit) ||
    (remoteLeft !== null && remoteLeft <= 0)

  return {
    configuredLimit,
    localUsed,
    localLeft,
    remoteLimit,
    remoteUsed,
    remoteLeft,
    renewalDate,
    full,
    remoteError,
    detail: quotaDetail({
      configuredLimit,
      localUsed,
      localLeft,
      remoteLeft,
      renewalDate,
      remoteError,
      full,
    }),
  }
}

async function serpApiProviderStatus(workspaceId?: string): Promise<ProviderStatus> {
  const bundle = await getConnectionBundle(workspaceId, 'search')
  if (bundle.decryptionError) {
    return { state: 'ERROR', detail: bundle.decryptionError }
  }
  if (!bundle.enabled) {
    return { state: 'NOT_CONFIGURED', detail: 'SerpApi search is disabled for this workspace.' }
  }
  const apiKey = await getConnectionSecret(workspaceId, 'search', 'apiKey')
  const kind = bundle.config.kind || 'serpapi'
  if (!apiKey) {
    return {
      state: 'NOT_CONFIGURED',
      detail: 'Add a SerpApi API key in Settings > Connections to enable these sources.',
    }
  }
  if (kind !== 'serpapi') {
    return {
      state: 'NOT_CONFIGURED',
      detail: `Provider kind "${kind}" does not support the SerpApi discovery engines.`,
    }
  }

  const quota = await getSerpApiQuotaStatus(workspaceId)
  if (quota.remoteError) return { state: 'ERROR', detail: quota.remoteError }
  if (quota.full) return { state: 'ERROR', detail: quota.detail }
  return { state: 'CONNECTED', detail: `SerpApi connected. ${quota.detail}` }
}

async function assertSerpApiQuota(workspaceId: string): Promise<void> {
  const quota = await getSerpApiQuotaStatus(workspaceId)
  if (!quota.full) return
  throw new Error(`${quota.detail} Save a fresh SerpApi key or raise the monthly limit in Settings > Connections.`)
}

async function getSerpApiMonthlyLimit(workspaceId?: string): Promise<number> {
  const bundle = await getConnectionBundle(workspaceId, 'search')
  const raw = bundle.config.monthlyLimit
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SERPAPI_MONTHLY_LIMIT
  return Math.floor(n)
}

function quotaDetail(quota: {
  configuredLimit: number
  localUsed: number
  localLeft: number | null
  remoteLeft: number | null
  renewalDate: string | null
  remoteError: string | null
  full: boolean
}): string {
  const local =
    quota.configuredLimit > 0
      ? `${quota.localUsed}/${quota.configuredLimit} SerpApi searches used locally this month`
      : `${quota.localUsed} SerpApi searches used locally this month; local cap disabled`
  const remote =
    quota.remoteLeft !== null
      ? `SerpApi reports ${quota.remoteLeft} searches left${quota.renewalDate ? ` until ${quota.renewalDate}` : ''}`
      : quota.remoteError
        ? `SerpApi account usage unavailable: ${quota.remoteError}`
        : null
  const suffix = quota.full ? ' Quota is full.' : ''
  return [local, remote].filter(Boolean).join('. ') + suffix
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null
}

function locationText(location: DiscoveryQuery['location']): string {
  return [location.area, location.city, location.region, location.country, location.postalCode]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(', ')
}

function businessNameFromTitle(raw: string | null | undefined): string | null {
  const first = raw
    ?.replace(/\s+/g, ' ')
    .split(/\s[-|]\s/)
    .map((part) => part.trim())
    .find(Boolean)
  if (!first) return null
  if (/\b(best|top|near me|directory|reviews?|jobs?|wikipedia|facebook|youtube|tripadvisor|yelp)\b/i.test(first)) {
    return null
  }
  return first.slice(0, 140)
}

function shouldSkipOrganicDomain(domain: string): boolean {
  const site = normalizeUrl(`https://${domain}`)
  if (!site) return true
  if (site.isSocial || site.isAggregator) return true
  return GENERAL_SEARCH_SKIP_DOMAINS.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))
}

const GENERAL_SEARCH_SKIP_DOMAINS = [
  'wikipedia.org',
  'wikimedia.org',
  'yelp.com',
  'tripadvisor.com',
  'foursquare.com',
  'yellowpages.com',
  'opentable.com',
  'doordash.com',
  'ubereats.com',
  'grubhub.com',
  'indeed.com',
  'glassdoor.com',
  'reddit.com',
  'quora.com',
  'youtube.com',
]

/** Google Maps zoom levels roughly halve the visible span per step. */
function radiusToZoom(radiusMeters: number): number {
  if (radiusMeters <= 500) return 17
  if (radiusMeters <= 1_000) return 16
  if (radiusMeters <= 2_000) return 15
  if (radiusMeters <= 5_000) return 14
  if (radiusMeters <= 10_000) return 13
  if (radiusMeters <= 25_000) return 12
  if (radiusMeters <= 50_000) return 11
  return 10
}
