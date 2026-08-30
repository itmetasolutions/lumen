import type { BBox } from '@/server/normalize/geo'

/**
 * The universal discovery contract (§2).
 *
 * Nothing above this layer knows that Google exists. Adding a provider means
 * implementing this interface and registering it — no other file changes.
 */

export type ProviderState = 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'

export interface ProviderStatus {
  state: ProviderState
  /** Shown verbatim in Settings → Integrations. Must explain *what to do*. */
  detail: string
}

export interface ProviderCapabilities {
  /** Can restrict results to a circle. */
  radius: boolean
  /** Can restrict results to a bounding box. */
  bbox: boolean
  ratings: boolean
  reviewCounts: boolean
  phone: boolean
  website: boolean
  email: boolean
  categories: boolean
  openingStatus: boolean
  /** Provider terms permit persisting its record id. */
  storesProviderId: boolean
  /** Approximate maximum results per single query. */
  maxResultsPerQuery: number
}

export interface GeoCell {
  index: number
  lat: number
  lng: number
  radiusMeters: number
  bbox: BBox
}

export interface LocationInput {
  country?: string | null
  countryCode?: string | null
  region?: string | null
  city?: string | null
  area?: string | null
  postalCode?: string | null
  radiusMeters?: number | null
  centerLat?: number | null
  centerLng?: number | null
  bbox?: BBox | null
}

export interface DiscoveryQuery {
  /** The literal search term for this execution. */
  term: string
  /** False only for the user's own words; true for our expansions (§2). */
  isExpanded: boolean
  originTerm: string
  cell: GeoCell
  location: LocationInput
  exclusions: string[]
  limit: number
}

/**
 * Provider output. Deliberately loose and optional-heavy: a provider must be able
 * to say "I don't know" rather than fill a field with a guess (§1).
 */
export interface RawBusiness {
  providerId?: string | null
  sourceUrl?: string | null

  name: string
  website?: string | null
  phones?: string[]
  emails?: string[]
  socials?: string[]

  addressLine?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  countryCode?: string | null
  area?: string | null

  latitude?: number | null
  longitude?: number | null

  category?: string | null
  categories?: string[]

  rating?: number | null
  reviewCount?: number | null
  openingStatus?: string | null

  /** Untouched provider payload, stored as provenance evidence (§19). */
  raw: unknown
  /** 0-100 trust in this source for conflict resolution. */
  confidence: number
}

export interface CostEstimate {
  /** Number of billable external calls this query will make. */
  requests: number
  /** Only populated when a price is actually configured — never invented. */
  estimatedUsd?: number
  note?: string
}

export interface ProviderRunContext {
  workspaceId: string
  jobId: string
  /** Records a provider call for the usage ledger (§33). */
  recordUsage(operation: string, units?: number): Promise<void>
  log(message: string, data?: unknown): void
  signal?: AbortSignal
}

export interface DiscoveryProvider {
  readonly id: string
  readonly label: string
  readonly description: string
  /** True for providers that synthesise data. Propagates to Business.isDemo. */
  readonly isDemo: boolean
  /** Link to the provider's terms, shown in Settings (§30). */
  readonly termsUrl?: string

  configured(workspaceId?: string): Promise<ProviderStatus>
  capabilities(): ProviderCapabilities
  estimateCost(query: DiscoveryQuery): CostEstimate
  search(query: DiscoveryQuery, ctx: ProviderRunContext): Promise<RawBusiness[]>
}
