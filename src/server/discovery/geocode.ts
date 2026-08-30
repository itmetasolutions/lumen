import 'server-only'
import { env } from '@/server/env'
import { httpJson, RateLimiter } from '@/server/http/client'
import { getConnectionSecret } from '@/server/settings/connections'
import type { BBox } from '@/server/normalize/geo'

/**
 * Turns the wizard's location words into coordinates and a bounding box.
 *
 * Nominatim is used by default because it needs no key, which keeps the product
 * usable out of the box. Its usage policy requires an identifying User-Agent and
 * at most one request per second — both enforced here (§30).
 */

const limiter = new RateLimiter(1, 1)

export interface GeocodeResult {
  displayName: string
  lat: number
  lng: number
  bbox: BBox | null
  countryCode: string | null
  country: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  /** Which administrative level actually matched — drives the default radius. */
  scope: 'area' | 'city' | 'region' | 'country'
  provider: 'nominatim' | 'google'
}

interface NominatimResult {
  display_name?: string
  lat?: string
  lon?: string
  boundingbox?: [string, string, string, string]
  type?: string
  addresstype?: string
  address?: Record<string, string>
}

export interface GeocodeQuery {
  country?: string | null
  region?: string | null
  city?: string | null
  area?: string | null
  postalCode?: string | null
}

function queryString(q: GeocodeQuery): string {
  return [q.area, q.city, q.postalCode, q.region, q.country]
    .filter((p) => p && p.trim())
    .join(', ')
}

function scopeFor(q: GeocodeQuery): GeocodeResult['scope'] {
  if (q.area?.trim() || q.postalCode?.trim()) return 'area'
  if (q.city?.trim()) return 'city'
  if (q.region?.trim()) return 'region'
  return 'country'
}

export async function geocode(
  q: GeocodeQuery,
  workspaceId?: string,
): Promise<GeocodeResult | null> {
  const search = queryString(q)
  if (!search) return null

  // Prefer Google's geocoder when a Maps key exists — it is more forgiving of
  // partial addresses — but never require it.
  const googleMapsApiKey = await getConnectionSecret(workspaceId, 'google-places', 'apiKey')
  if (googleMapsApiKey) {
    const viaGoogle = await geocodeGoogle(search, q, googleMapsApiKey).catch(() => null)
    if (viaGoogle) return viaGoogle
  }
  return geocodeNominatim(search, q)
}

async function geocodeNominatim(
  search: string,
  q: GeocodeQuery,
): Promise<GeocodeResult | null> {
  await limiter.acquire('nominatim')

  const params = new URLSearchParams({
    q: search,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
  })

  const results = await httpJson<NominatimResult[]>(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    {
      headers: { 'user-agent': env.crawlerUserAgent },
      timeoutMs: 20_000,
      retries: 1,
    },
  )

  const hit = results?.[0]
  if (!hit?.lat || !hit?.lon) return null

  const addr = hit.address ?? {}
  const bb = hit.boundingbox
  const bbox: BBox | null = bb
    ? {
        minLat: Number(bb[0]),
        maxLat: Number(bb[1]),
        minLng: Number(bb[2]),
        maxLng: Number(bb[3]),
      }
    : null

  return {
    displayName: hit.display_name ?? search,
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    bbox: bbox && Number.isFinite(bbox.minLat) ? bbox : null,
    countryCode: addr.country_code?.toUpperCase() ?? null,
    country: addr.country ?? q.country ?? null,
    city: addr.city ?? addr.town ?? addr.village ?? q.city ?? null,
    region: addr.state ?? addr.county ?? q.region ?? null,
    postalCode: addr.postcode ?? q.postalCode ?? null,
    scope: scopeFor(q),
    provider: 'nominatim',
  }
}

interface GoogleGeocodeResponse {
  status?: string
  results?: Array<{
    formatted_address?: string
    geometry?: {
      location?: { lat: number; lng: number }
      viewport?: {
        northeast?: { lat: number; lng: number }
        southwest?: { lat: number; lng: number }
      }
    }
    address_components?: Array<{
      long_name?: string
      short_name?: string
      types?: string[]
    }>
  }>
}

async function geocodeGoogle(
  search: string,
  q: GeocodeQuery,
  apiKey: string,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    address: search,
    key: apiKey,
  })
  const data = await httpJson<GoogleGeocodeResponse>(
    `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`,
    { timeoutMs: 15_000, retries: 1 },
  )
  if (data.status !== 'OK' || !data.results?.length) return null

  const r = data.results[0]!
  const loc = r.geometry?.location
  if (!loc) return null

  const comp = (type: string, short = false) => {
    const hit = r.address_components?.find((c) => c.types?.includes(type))
    return (short ? hit?.short_name : hit?.long_name) ?? null
  }

  const vp = r.geometry?.viewport
  const bbox: BBox | null =
    vp?.northeast && vp?.southwest
      ? {
          minLat: vp.southwest.lat,
          minLng: vp.southwest.lng,
          maxLat: vp.northeast.lat,
          maxLng: vp.northeast.lng,
        }
      : null

  return {
    displayName: r.formatted_address ?? search,
    lat: loc.lat,
    lng: loc.lng,
    bbox,
    countryCode: comp('country', true),
    country: comp('country') ?? q.country ?? null,
    city: comp('postal_town') ?? comp('locality') ?? q.city ?? null,
    region: comp('administrative_area_level_1') ?? q.region ?? null,
    postalCode: comp('postal_code') ?? q.postalCode ?? null,
    scope: scopeFor(q),
    provider: 'google',
  }
}
