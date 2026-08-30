import 'server-only'
import { normalizeName } from '@/server/normalize/name'
import { normalizePhone } from '@/server/normalize/phone'
import { normalizeUrl, socialNetworkOf } from '@/server/normalize/url'
import { normalizePostalCode } from '@/server/normalize/address'
import { geohash } from '@/server/normalize/geo'
import type { RawBusiness } from './types'

/**
 * Provider payload → internal draft (§2 "normalize into one internal entity").
 *
 * This is the *only* place a provider's shape is translated. Two rules govern it:
 *  - never invent a value to fill a field (§1)
 *  - never discard the original: `raw` is retained as provenance evidence (§19)
 */

export interface DraftContact {
  kind: 'PHONE' | 'EMAIL' | 'SOCIAL'
  value: string
  normalized: string
  label: string | null
  confidence: number
}

export interface BusinessDraft {
  name: string
  normalizedName: string
  industry: string | null
  category: string | null
  categories: string[]

  addressLine: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  countryCode: string | null
  area: string | null

  latitude: number | null
  longitude: number | null
  geohash: string | null

  websiteUrl: string | null
  websiteDomain: string | null
  /** True when the only "website" found was a social profile (§ website detection). */
  websiteIsSocialOnly: boolean

  rating: number | null
  reviewCount: number | null
  openingStatus: string | null

  contacts: DraftContact[]

  provider: string
  providerId: string | null
  sourceUrl: string | null
  sourceConfidence: number
  isDemo: boolean
  raw: unknown
}

const OPENING_STATUS_MAP: Record<string, string> = {
  OPERATIONAL: 'OPERATIONAL',
  CLOSED_TEMPORARILY: 'CLOSED_TEMPORARILY',
  CLOSED_PERMANENTLY: 'CLOSED_PERMANENTLY',
  OPEN: 'OPERATIONAL',
  'BUSINESS_STATUS_UNSPECIFIED': 'OPERATIONAL',
}

export function normalizeRawBusiness(
  raw: RawBusiness,
  meta: { provider: string; isDemo: boolean; industry: string },
): BusinessDraft | null {
  const name = raw.name?.trim()
  if (!name) return null

  const normalizedName = normalizeName(name)
  if (!normalizedName) return null

  const countryCode = normalizeCountryCode(raw.countryCode ?? raw.country)

  // ── Website: separate a real site from a social profile.
  const siteCandidates = [raw.website, ...(raw.socials ?? [])].filter(
    (u): u is string => Boolean(u && u.trim()),
  )
  let websiteUrl: string | null = null
  let websiteDomain: string | null = null
  let websiteIsSocialOnly = false
  const socialUrls: string[] = []

  for (const candidate of siteCandidates) {
    const n = normalizeUrl(candidate)
    if (!n) continue
    if (n.isSocial) {
      socialUrls.push(n.href)
      continue
    }
    // An aggregator listing page is not the business's own website. Recording it
    // as one would wrongly disqualify a genuine Website Creation lead.
    if (n.isAggregator) continue
    if (!websiteUrl) {
      websiteUrl = n.href
      websiteDomain = n.domain
    }
  }
  if (!websiteUrl && socialUrls.length > 0) websiteIsSocialOnly = true

  // ── Contacts
  const contacts: DraftContact[] = []
  const seen = new Set<string>()

  for (const [i, phone] of (raw.phones ?? []).entries()) {
    const p = normalizePhone(phone, countryCode)
    if (!p) continue
    const key = `PHONE:${p.normalized}`
    if (seen.has(key)) continue
    seen.add(key)
    contacts.push({
      kind: 'PHONE',
      value: p.display,
      normalized: p.normalized,
      label: i === 0 ? 'primary' : null,
      // An un-inferable country code lowers confidence rather than being hidden.
      confidence: p.confident ? raw.confidence : Math.max(30, raw.confidence - 25),
    })
  }

  for (const email of raw.emails ?? []) {
    const e = normalizeEmail(email)
    if (!e) continue
    const key = `EMAIL:${e}`
    if (seen.has(key)) continue
    seen.add(key)
    contacts.push({
      kind: 'EMAIL',
      value: email.trim(),
      normalized: e,
      label: null,
      confidence: raw.confidence,
    })
  }

  for (const social of socialUrls) {
    const key = `SOCIAL:${social}`
    if (seen.has(key)) continue
    seen.add(key)
    contacts.push({
      kind: 'SOCIAL',
      value: social,
      normalized: social,
      label: socialNetworkOf(social),
      confidence: raw.confidence,
    })
  }

  const lat = isFiniteNumber(raw.latitude) ? raw.latitude : null
  const lng = isFiniteNumber(raw.longitude) ? raw.longitude : null

  return {
    name,
    normalizedName,
    industry: meta.industry,
    category: raw.category?.trim() || null,
    categories: (raw.categories ?? []).map((c) => c.trim()).filter(Boolean),

    addressLine: raw.addressLine?.trim() || null,
    city: raw.city?.trim() || null,
    region: raw.region?.trim() || null,
    postalCode: normalizePostalCode(raw.postalCode, countryCode),
    country: raw.country?.trim() || null,
    countryCode,
    area: raw.area?.trim() || null,

    latitude: lat,
    longitude: lng,
    geohash: lat !== null && lng !== null ? geohash(lat, lng, 6) : null,

    websiteUrl,
    websiteDomain,
    websiteIsSocialOnly,

    rating: isFiniteNumber(raw.rating) ? clampRating(raw.rating) : null,
    reviewCount:
      isFiniteNumber(raw.reviewCount) && raw.reviewCount >= 0
        ? Math.round(raw.reviewCount)
        : null,
    openingStatus: raw.openingStatus
      ? (OPENING_STATUS_MAP[raw.openingStatus.toUpperCase()] ?? null)
      : null,

    contacts,

    provider: meta.provider,
    providerId: raw.providerId ?? null,
    sourceUrl: raw.sourceUrl ?? null,
    sourceConfidence: clamp(raw.confidence, 0, 100),
    isDemo: meta.isDemo,
    raw: raw.raw,
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function clampRating(r: number): number | null {
  if (r < 0 || r > 5) return null
  return Math.round(r * 10) / 10
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const e = raw.trim().toLowerCase().replace(/^mailto:/, '')
  // Deliberately strict: a false positive email is worse than a missing one.
  if (!/^[^\s@,;:<>()[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(e)) {
    return null
  }
  // Filter placeholder addresses that appear in templates.
  if (/^(example|test|your|email|name|user|info)@(example|test|domain|yourdomain|email)\./.test(e)) {
    return null
  }
  return e
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB',
  scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  'united states': 'US', usa: 'US', 'united states of america': 'US',
  canada: 'CA', ireland: 'IE', australia: 'AU', 'new zealand': 'NZ',
  germany: 'DE', deutschland: 'DE', france: 'FR', spain: 'ES', espana: 'ES',
  italy: 'IT', italia: 'IT', netherlands: 'NL', belgium: 'BE', portugal: 'PT',
  sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI', poland: 'PL',
  switzerland: 'CH', austria: 'AT', india: 'IN', pakistan: 'PK',
  'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA',
  'south africa': 'ZA', singapore: 'SG', malaysia: 'MY', japan: 'JP',
  brazil: 'BR', mexico: 'MX',
}

export function normalizeCountryCode(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (!s) return null
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase()
  return COUNTRY_NAME_TO_CODE[s.toLowerCase()] ?? null
}
