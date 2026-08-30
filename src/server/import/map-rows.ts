import 'server-only'
import { EXPORT_COLUMNS } from '@/server/export/columns'
import { normalizeCountryCode } from '@/server/discovery/normalize'
import type { RawBusiness } from '@/server/discovery/types'
import type { ParsedRow } from './parse'

/**
 * Maps an exported row back into the shape the discovery pipeline understands.
 *
 * Two rules define what crosses the boundary:
 *
 * 1. **Facts import; scores do not.** Names, addresses, phones, ratings and
 *    review counts describe the business and travel fine. SEO health, lead
 *    score, opportunity flags and audit findings describe *an audit that ran in
 *    another workspace* — importing them would present another installation's
 *    measurements as this one's. They are ignored, and recomputed when the
 *    target workspace audits the site itself.
 *
 * 2. **"Not Found" means absent.** The exporter writes that string for missing
 *    values; importing it literally would create businesses whose phone number
 *    is the text "Not Found".
 */

const NOT_FOUND_VALUES = new Set(['not found', 'n/a', 'na', 'none', '-', '—', 'null', 'undefined'])

/** Header aliases, so a hand-edited or re-saved file still imports. */
const ALIASES: Record<string, string[]> = {
  name: ['business name', 'name', 'business', 'company', 'company name', 'title'],
  industry: ['industry'],
  category: ['category', 'primary category', 'type'],
  categories: ['secondary categories', 'categories'],
  primaryPhone: ['phone', 'phone number', 'telephone', 'primary phone'],
  additionalPhones: ['additional phones', 'other phones'],
  primaryEmail: ['email', 'email address', 'primary email'],
  socials: ['social profiles', 'socials', 'social'],
  websiteUrl: ['website', 'website url', 'url', 'site'],
  addressLine: ['address', 'street address', 'address line'],
  city: ['city', 'town'],
  region: ['region', 'state', 'county', 'province'],
  postalCode: ['postal code', 'postcode', 'zip', 'zip code'],
  country: ['country'],
  area: ['area', 'neighbourhood', 'neighborhood'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lng', 'lon'],
  rating: ['rating', 'stars'],
  reviewCount: ['reviews', 'review count', 'total reviews'],
  openingStatus: ['opening status', 'business status', 'status'],
  tags: ['tags'],
  outreachStage: ['contact status', 'outreach status', 'stage'],
  sources: ['discovery sources', 'sources', 'source'],
  isDemo: ['data type'],
}

/** Export column ids whose values are audit output and must not be imported. */
const DERIVED_COLUMN_IDS = new Set(
  EXPORT_COLUMNS.filter((c) =>
    ['Scores', 'Opportunity', 'Evidence'].includes(c.group),
  ).map((c) => c.id),
)

export interface RowMapping {
  /** field → the header in this file that supplies it. */
  resolved: Record<string, string>
  /** Headers present in the file that the importer ignores, with why. */
  ignored: Array<{ header: string; reason: string }>
  missingRequired: string[]
}

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function mapHeaders(headers: string[]): RowMapping {
  const resolved: Record<string, string> = {}
  const used = new Set<string>()

  for (const [field, aliases] of Object.entries(ALIASES)) {
    const match = headers.find((h) => aliases.includes(normaliseHeader(h)))
    if (match) {
      resolved[field] = match
      used.add(match)
    }
  }

  const derivedLabels = new Set(
    EXPORT_COLUMNS.filter((c) => DERIVED_COLUMN_IDS.has(c.id)).map((c) =>
      normaliseHeader(c.label),
    ),
  )

  const ignored = headers
    .filter((h) => h && !used.has(h))
    .map((h) => ({
      header: h,
      reason: derivedLabels.has(normaliseHeader(h))
        ? 'Audit result — recomputed here rather than imported'
        : 'Not a recognised field',
    }))

  return {
    resolved,
    ignored,
    missingRequired: resolved.name ? [] : ['Business Name'],
  }
}

/**
 * Reverses the exporter's spreadsheet-formula guard.
 *
 * The CSV writer prefixes any cell starting with = + - @ with an apostrophe, so
 * Excel cannot execute it. Every phone number starts with "+", which means a
 * naive round trip turns +44161... into '+44161... and the number is corrupted.
 * Only strip when the next character is one that was actually guarded, so a
 * value that genuinely begins with an apostrophe is left alone.
 */
const GUARDED_FIRST_CHARS = new Set(['=', '+', '-', '@', '\t', '\r'])

function unguard(value: string): string {
  return value.startsWith("'") && GUARDED_FIRST_CHARS.has(value.charAt(1))
    ? value.slice(1)
    : value
}

function value(row: ParsedRow, mapping: RowMapping, field: string): string | null {
  const header = mapping.resolved[field]
  if (!header) return null
  const raw = row[header]
  if (raw === undefined) return null
  const trimmed = unguard(raw.trim())
  if (!trimmed) return null
  if (NOT_FOUND_VALUES.has(trimmed.toLowerCase())) return null
  return trimmed
}

function list(row: ParsedRow, mapping: RowMapping, field: string): string[] {
  const raw = value(row, mapping, field)
  if (!raw) return []
  return raw
    .split(/[|,;]/)
    .map((v) => unguard(v.trim()))
    .filter((v) => v.length > 0 && !NOT_FOUND_VALUES.has(v.toLowerCase()))
}

function number(row: ParsedRow, mapping: RowMapping, field: string): number | null {
  const raw = value(row, mapping, field)
  if (!raw) return null
  // Tolerate "4.5★", "1,234" and stray currency or spacing.
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (!cleaned) return null
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

export interface MappedRow {
  business: RawBusiness
  tags: string[]
  outreachStage: string | null
  /** True when the source file marked this row as demo data. */
  isDemo: boolean
}

/**
 * Converts one parsed row. Returns null when the row has no usable name, since
 * a business without a name cannot be resolved against anything.
 */
export function mapRow(row: ParsedRow, mapping: RowMapping): MappedRow | null {
  const name = value(row, mapping, 'name')
  if (!name) return null

  const countryCode =
    normalizeCountryCode(value(row, mapping, 'country')) ?? null

  const phones = [
    value(row, mapping, 'primaryPhone'),
    ...list(row, mapping, 'additionalPhones'),
  ].filter((p): p is string => Boolean(p))

  const email = value(row, mapping, 'primaryEmail')
  const rating = number(row, mapping, 'rating')
  const reviewCount = number(row, mapping, 'reviewCount')

  const dataType = value(row, mapping, 'isDemo')

  return {
    business: {
      // The exporter does not carry provider record ids, so the resolver falls
      // back to its synthetic key and matches on name, phone, domain and geo.
      providerId: null,
      sourceUrl: null,
      name,
      website: value(row, mapping, 'websiteUrl'),
      phones,
      emails: email ? [email] : [],
      socials: list(row, mapping, 'socials'),
      addressLine: value(row, mapping, 'addressLine'),
      city: value(row, mapping, 'city'),
      region: value(row, mapping, 'region'),
      postalCode: value(row, mapping, 'postalCode'),
      country: value(row, mapping, 'country'),
      countryCode,
      area: value(row, mapping, 'area'),
      latitude: number(row, mapping, 'latitude'),
      longitude: number(row, mapping, 'longitude'),
      category: value(row, mapping, 'category'),
      categories: list(row, mapping, 'categories'),
      rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
      reviewCount: reviewCount !== null && reviewCount >= 0 ? Math.round(reviewCount) : null,
      openingStatus: value(row, mapping, 'openingStatus'),
      raw: row,
      // Imported rows are second-hand: whatever produced them is not observable
      // from here, so they must not outrank a live provider on conflict.
      confidence: 55,
    },
    tags: list(row, mapping, 'tags'),
    outreachStage: value(row, mapping, 'outreachStage'),
    isDemo: dataType?.toUpperCase().includes('DEMO') ?? false,
  }
}
