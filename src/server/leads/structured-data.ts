import 'server-only'
import * as cheerio from 'cheerio'
import { normalizeEmail } from '@/server/discovery/normalize'
import { normalizePhone } from '@/server/normalize/phone'
import { normalizeUrl, resolveUrl, socialNetworkOf } from '@/server/normalize/url'
import type { CrawlResult } from '@/server/crawler/crawl'

/**
 * schema.org extraction from a business's own website.
 *
 * A large share of business sites publish JSON-LD `LocalBusiness` data — name,
 * address, phone, opening hours, price range, sometimes an aggregate rating —
 * because it is what search engines ask for. Reading it is free, needs no API
 * quota, and does not break when the site is restyled, unlike scraping rendered
 * markup.
 *
 * Every field is optional and every parse is defensive: malformed JSON-LD is
 * common, and a wrong value is worse than a missing one.
 */

export interface StructuredBusinessData {
  name: string | null
  legalName: string | null
  description: string | null
  phones: string[]
  emails: string[]
  websites: string[]
  socials: string[]
  addressLine: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  priceRange: string | null
  openingHours: string[]
  rating: number | null
  reviewCount: number | null
  schemaTypes: string[]
  /** Page the data was read from, for provenance. */
  sourceUrl: string | null
}

const EMPTY: StructuredBusinessData = {
  name: null,
  legalName: null,
  description: null,
  phones: [],
  emails: [],
  websites: [],
  socials: [],
  addressLine: null,
  city: null,
  region: null,
  postalCode: null,
  country: null,
  latitude: null,
  longitude: null,
  priceRange: null,
  openingHours: [],
  rating: null,
  reviewCount: null,
  schemaTypes: [],
  sourceUrl: null,
}

/** schema.org types that describe a business rather than a page or article. */
const BUSINESS_TYPE = /^(LocalBusiness|Organization|Corporation|Store|Restaurant|Dentist|Physician|MedicalBusiness|ProfessionalService|HomeAndConstructionBusiness|AutomotiveBusiness|LegalService|HealthAndBeautyBusiness|FoodEstablishment|Hotel|LodgingBusiness|EntertainmentBusiness|SportsActivityLocation|ChildCare|EducationalOrganization|FinancialService|RealEstateAgent|TravelAgency|Plumber|Electrician|RoofingContractor|GeneralContractor|Locksmith|MovingCompany|HousePainter|Notary|Attorney|AccountingService|InsuranceAgency|VeterinaryCare|Optician|Pharmacy|BeautySalon|HairSalon|NailSalon|DaySpa|HealthClub|Gym|Bakery|BarOrPub|CafeOrCoffeeShop|IceCreamShop|Winery|Brewery)$/i

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim()
    return t || null
  }
  if (typeof v === 'number') return String(v)
  return null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** JSON-LD values are routinely a string, an object, or an array of either. */
function asArray(v: unknown): unknown[] {
  if (v === null || v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node['@type']
  if (typeof t === 'string') return [t]
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string')
  return []
}

function isBusinessNode(node: Record<string, unknown>): boolean {
  return typesOf(node).some((t) => BUSINESS_TYPE.test(t.replace(/^https?:\/\/schema\.org\//, '')))
}

/** Walks @graph, arrays and nested objects to find every business-like node. */
function collectBusinessNodes(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return

  if (Array.isArray(value)) {
    for (const item of value) collectBusinessNodes(item, out, depth + 1)
    return
  }

  const node = value as Record<string, unknown>
  if (isBusinessNode(node)) out.push(node)

  for (const key of ['@graph', 'mainEntity', 'about', 'publisher', 'provider', 'parentOrganization']) {
    if (node[key] !== undefined) collectBusinessNodes(node[key], out, depth + 1)
  }
}

function readAddress(node: Record<string, unknown>, into: StructuredBusinessData): void {
  const address = asArray(node.address)[0]
  if (!address) return

  if (typeof address === 'string') {
    into.addressLine = into.addressLine ?? str(address)
    return
  }
  if (typeof address !== 'object') return

  const a = address as Record<string, unknown>
  into.addressLine = into.addressLine ?? str(a.streetAddress)
  into.city = into.city ?? str(a.addressLocality)
  into.region = into.region ?? str(a.addressRegion)
  into.postalCode = into.postalCode ?? str(a.postalCode)
  into.country = into.country ?? str(a.addressCountry) ?? str((a.addressCountry as Record<string, unknown>)?.name)
}

function readGeo(node: Record<string, unknown>, into: StructuredBusinessData): void {
  const geo = asArray(node.geo)[0]
  if (!geo || typeof geo !== 'object') return
  const g = geo as Record<string, unknown>
  const lat = num(g.latitude)
  const lng = num(g.longitude)
  // Reject the null island and out-of-range values rather than storing nonsense.
  if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) {
    into.latitude = into.latitude ?? lat
    into.longitude = into.longitude ?? lng
  }
}

function readRating(node: Record<string, unknown>, into: StructuredBusinessData): void {
  const agg = asArray(node.aggregateRating)[0]
  if (!agg || typeof agg !== 'object') return
  const a = agg as Record<string, unknown>
  const value = num(a.ratingValue)
  const count = num(a.reviewCount) ?? num(a.ratingCount)
  // A self-published rating is only meaningful inside a sane range.
  if (value !== null && value >= 0 && value <= 5) into.rating = into.rating ?? value
  if (count !== null && count >= 0) into.reviewCount = into.reviewCount ?? Math.round(count)
}

function readOpeningHours(node: Record<string, unknown>, into: StructuredBusinessData): void {
  for (const spec of asArray(node.openingHoursSpecification)) {
    if (!spec || typeof spec !== 'object') continue
    const s = spec as Record<string, unknown>
    const days = asArray(s.dayOfWeek).map((d) => str(d)?.split('/').pop()).filter(Boolean)
    const opens = str(s.opens)
    const closes = str(s.closes)
    if (days.length > 0 && opens && closes) {
      into.openingHours.push(`${days.join(', ')} ${opens}-${closes}`)
    }
  }
  for (const raw of asArray(node.openingHours)) {
    const v = str(raw)
    if (v) into.openingHours.push(v)
  }
}

function mergeNode(
  node: Record<string, unknown>,
  into: StructuredBusinessData,
  pageUrl: string,
  countryCode: string | null,
): void {
  into.schemaTypes.push(...typesOf(node))
  into.name = into.name ?? str(node.name)
  into.legalName = into.legalName ?? str(node.legalName)
  into.description = into.description ?? str(node.description)
  into.priceRange = into.priceRange ?? str(node.priceRange)

  for (const key of ['telephone', 'phone', 'faxNumber']) {
    for (const raw of asArray(node[key])) {
      const v = str(raw)
      if (!v) continue
      const p = normalizePhone(v, countryCode)
      if (p) into.phones.push(p.normalized)
    }
  }

  for (const raw of asArray(node.email)) {
    const v = normalizeEmail(str(raw))
    if (v) into.emails.push(v)
  }

  for (const key of ['url', 'sameAs']) {
    for (const raw of asArray(node[key])) {
      const v = str(raw)
      if (!v) continue
      const abs = resolveUrl(pageUrl, v)
      const n = abs ? normalizeUrl(abs) : null
      if (!n) continue
      if (n.isSocial) into.socials.push(n.href)
      else if (!n.isAggregator) into.websites.push(n.href)
    }
  }

  readAddress(node, into)
  readGeo(node, into)
  readRating(node, into)
  readOpeningHours(node, into)
}

/**
 * Extracts structured business data from every crawled page.
 *
 * Earlier pages win on conflict, and the homepage is crawled first, so the
 * canonical values are preferred over anything a deeper page repeats.
 */
export function extractStructuredData(
  crawl: CrawlResult,
  countryCode?: string | null,
): StructuredBusinessData {
  const result: StructuredBusinessData = {
    ...EMPTY,
    phones: [],
    emails: [],
    websites: [],
    socials: [],
    openingHours: [],
    schemaTypes: [],
  }

  for (const page of crawl.pages) {
    if (!page.html || page.error) continue

    const $ = cheerio.load(page.html)
    const nodes: Record<string, unknown>[] = []

    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text()
      if (!raw?.trim()) return
      try {
        collectBusinessNodes(JSON.parse(raw), nodes)
      } catch {
        // Malformed JSON-LD is common. Skip this block; the rest may be valid.
      }
    })

    if (nodes.length === 0) continue

    for (const node of nodes) {
      mergeNode(node, result, page.finalUrl, countryCode ?? null)
    }
    result.sourceUrl = result.sourceUrl ?? page.finalUrl
  }

  // Dedupe while preserving the order values were found in.
  result.phones = [...new Set(result.phones)]
  result.emails = [...new Set(result.emails)]
  result.websites = [...new Set(result.websites)]
  result.socials = [...new Set(result.socials)]
  result.openingHours = [...new Set(result.openingHours)]
  result.schemaTypes = [...new Set(result.schemaTypes)]

  return result
}

/** True when the extraction found anything worth recording. */
export function hasStructuredData(d: StructuredBusinessData): boolean {
  return (
    d.phones.length > 0 ||
    d.emails.length > 0 ||
    d.socials.length > 0 ||
    d.openingHours.length > 0 ||
    d.priceRange !== null ||
    d.addressLine !== null ||
    d.rating !== null
  )
}

export function socialLabel(url: string): string | null {
  return socialNetworkOf(url)
}
