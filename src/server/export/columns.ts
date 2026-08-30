import type { Prisma } from '@prisma/client'

/**
 * Export column registry (§9).
 *
 * One definition per column: its label in the file, how to read it from a row,
 * and a sensible width for XLSX. The user picks a subset before exporting; the
 * order here is the default order in the file.
 */

export const EXPORT_INCLUDE = {
  sources: { select: { provider: true, sourceUrl: true, isDemo: true, retrievedAt: true } },
  contacts: { select: { kind: true, value: true, normalized: true, label: true } },
  outreach: { select: { stage: true, lastContactAt: true, nextFollowUpAt: true } },
  opportunities: { select: { kind: true, triggered: true, score: true, reasons: true } },
  website: { select: { domain: true, isHttps: true, status: true, cms: true } },
} satisfies Prisma.BusinessInclude

export type ExportRow = Prisma.BusinessGetPayload<{ include: typeof EXPORT_INCLUDE }>

export interface ExportColumn {
  id: string
  label: string
  group: string
  width: number
  /** Returns a primitive; null becomes "Not Found" in the file (§1). */
  get: (row: ExportRow) => string | number | null
}

const NOT_FOUND = 'Not Found'

function contactsOf(row: ExportRow, kind: 'PHONE' | 'EMAIL' | 'SOCIAL'): string[] {
  return row.contacts.filter((c) => c.kind === kind).map((c) => c.value)
}

function opportunityReasons(row: ExportRow): string {
  const triggered = row.opportunities.filter((o) => o.triggered)
  if (triggered.length === 0) return NOT_FOUND
  return triggered
    .map((o) => {
      const reasons = Array.isArray(o.reasons)
        ? (o.reasons as Array<{ label?: string }>)
            .map((r) => r.label)
            .filter(Boolean)
            .slice(0, 4)
            .join('; ')
        : ''
      return `${labelForKind(o.kind)} (${o.score}/100)${reasons ? `: ${reasons}` : ''}`
    })
    .join(' | ')
}

function labelForKind(kind: string): string {
  return (
    {
      WEBSITE_CREATION: 'Website Creation',
      REDESIGN: 'Redesign',
      SEO: 'SEO',
      SPEED: 'Speed',
    }[kind] ?? kind
  )
}

export const EXPORT_COLUMNS: ExportColumn[] = [
  // ── Identity
  { id: 'name', label: 'Business Name', group: 'Business', width: 34, get: (r) => r.name },
  { id: 'industry', label: 'Industry', group: 'Business', width: 18, get: (r) => r.industry },
  { id: 'category', label: 'Category', group: 'Business', width: 20, get: (r) => r.category },
  { id: 'categories', label: 'Secondary Categories', group: 'Business', width: 28, get: (r) => (r.categories.length ? r.categories.join(', ') : null) },

  // ── Contact
  { id: 'primaryPhone', label: 'Phone', group: 'Contact', width: 18, get: (r) => r.primaryPhone },
  {
    id: 'additionalPhones',
    label: 'Additional Phones',
    group: 'Contact',
    width: 24,
    get: (r) => {
      const all = contactsOf(r, 'PHONE')
      const extra = all.filter((p) => p !== r.primaryPhone)
      return extra.length ? extra.join(', ') : null
    },
  },
  { id: 'primaryEmail', label: 'Email', group: 'Contact', width: 28, get: (r) => r.primaryEmail },
  { id: 'socials', label: 'Social Profiles', group: 'Contact', width: 34, get: (r) => { const s = contactsOf(r, 'SOCIAL'); return s.length ? s.join(', ') : null } },

  // ── Website
  { id: 'websiteUrl', label: 'Website', group: 'Website', width: 34, get: (r) => r.websiteUrl },
  { id: 'websiteDomain', label: 'Domain', group: 'Website', width: 24, get: (r) => r.websiteDomain },
  { id: 'websiteStatus', label: 'Website Status', group: 'Website', width: 16, get: (r) => r.websiteStatus },
  { id: 'isHttps', label: 'HTTPS', group: 'Website', width: 8, get: (r) => (r.website ? (r.website.isHttps ? 'Yes' : 'No') : null) },
  { id: 'cms', label: 'CMS / Technology', group: 'Website', width: 18, get: (r) => r.website?.cms ?? null },

  // ── Location
  { id: 'addressLine', label: 'Address', group: 'Location', width: 34, get: (r) => r.addressLine },
  { id: 'city', label: 'City', group: 'Location', width: 18, get: (r) => r.city },
  { id: 'region', label: 'Region', group: 'Location', width: 18, get: (r) => r.region },
  { id: 'postalCode', label: 'Postal Code', group: 'Location', width: 12, get: (r) => r.postalCode },
  { id: 'country', label: 'Country', group: 'Location', width: 16, get: (r) => r.country },
  { id: 'area', label: 'Area', group: 'Location', width: 18, get: (r) => r.area },
  { id: 'latitude', label: 'Latitude', group: 'Location', width: 12, get: (r) => r.latitude },
  { id: 'longitude', label: 'Longitude', group: 'Location', width: 12, get: (r) => r.longitude },

  // ── Marketplace
  { id: 'rating', label: 'Rating', group: 'Reputation', width: 9, get: (r) => r.rating },
  { id: 'reviewCount', label: 'Reviews', group: 'Reputation', width: 9, get: (r) => r.reviewCount },
  { id: 'openingStatus', label: 'Opening Status', group: 'Reputation', width: 18, get: (r) => r.openingStatus },

  // ── Scores
  { id: 'leadScore', label: 'Lead Score', group: 'Scores', width: 11, get: (r) => r.leadScore },
  { id: 'leadTier', label: 'Lead Tier', group: 'Scores', width: 10, get: (r) => r.leadTier },
  { id: 'dataConfidence', label: 'Data Confidence', group: 'Scores', width: 14, get: (r) => r.dataConfidence },
  { id: 'websiteHealth', label: 'Website Health', group: 'Scores', width: 13, get: (r) => r.websiteHealth },
  { id: 'seoHealth', label: 'SEO Health', group: 'Scores', width: 11, get: (r) => r.seoHealth },
  { id: 'uxHealth', label: 'UX Health', group: 'Scores', width: 11, get: (r) => r.uxHealth },
  { id: 'technicalHealth', label: 'Technical Health', group: 'Scores', width: 14, get: (r) => r.technicalHealth },
  { id: 'perfScoreMobile', label: 'Performance (Mobile)', group: 'Scores', width: 17, get: (r) => r.perfScoreMobile },
  { id: 'perfScoreDesktop', label: 'Performance (Desktop)', group: 'Scores', width: 18, get: (r) => r.perfScoreDesktop },

  // ── Opportunity
  { id: 'opportunities', label: 'Opportunities', group: 'Opportunity', width: 30, get: (r) => { const t = r.opportunities.filter((o) => o.triggered).map((o) => labelForKind(o.kind)); return t.length ? t.join(', ') : 'None' } },
  { id: 'websiteCreationOpp', label: 'Website Creation Score', group: 'Opportunity', width: 18, get: (r) => r.websiteCreationOpp },
  { id: 'redesignOpp', label: 'Redesign Score', group: 'Opportunity', width: 14, get: (r) => r.redesignOpp },
  { id: 'seoOpp', label: 'SEO Opportunity Score', group: 'Opportunity', width: 18, get: (r) => r.seoOpp },
  { id: 'speedOpp', label: 'Speed Opportunity Score', group: 'Opportunity', width: 19, get: (r) => r.speedOpp },
  { id: 'auditReasons', label: 'Audit Reasons', group: 'Opportunity', width: 70, get: opportunityReasons },

  // ── Evidence counts
  { id: 'seoIssueCount', label: 'SEO Issues', group: 'Evidence', width: 11, get: (r) => r.seoIssueCount },
  { id: 'uxIssueCount', label: 'UX Issues', group: 'Evidence', width: 11, get: (r) => r.uxIssueCount },
  { id: 'brokenLinkCount', label: 'Broken Links', group: 'Evidence', width: 12, get: (r) => r.brokenLinkCount },
  { id: 'uxBrokenImages', label: 'Broken Images', group: 'Evidence', width: 13, get: (r) => r.uxBrokenImages },
  { id: 'lcpMobileMs', label: 'Mobile LCP (ms)', group: 'Evidence', width: 14, get: (r) => r.lcpMobileMs },
  { id: 'clsMobile', label: 'Mobile CLS', group: 'Evidence', width: 11, get: (r) => r.clsMobile },
  { id: 'pageWeightBytes', label: 'Page Weight (bytes)', group: 'Evidence', width: 17, get: (r) => r.pageWeightBytes },

  // ── Provenance & workflow
  {
    id: 'sources',
    label: 'Discovery Sources',
    group: 'Provenance',
    width: 26,
    get: (r) => (r.sources.length ? r.sources.map((s) => s.provider).join(', ') : null),
  },
  {
    id: 'sourceUrls',
    label: 'Source URLs',
    group: 'Provenance',
    width: 40,
    get: (r) => {
      const urls = r.sources.map((s) => s.sourceUrl).filter(Boolean) as string[]
      return urls.length ? urls.join(' | ') : null
    },
  },
  {
    id: 'isDemo',
    label: 'Data Type',
    group: 'Provenance',
    width: 12,
    // §21/§44: the DEMO DATA marker must survive into the exported file.
    get: (r) => (r.isDemo ? 'DEMO DATA' : 'Live'),
  },
  { id: 'discoveredAt', label: 'Date Found', group: 'Dates', width: 20, get: (r) => iso(r.discoveredAt) },
  { id: 'lastAuditedAt', label: 'Last Audited', group: 'Dates', width: 20, get: (r) => iso(r.lastAuditedAt) },
  { id: 'lastSeenAt', label: 'Last Seen', group: 'Dates', width: 20, get: (r) => iso(r.lastSeenAt) },
  { id: 'outreachStage', label: 'Contact Status', group: 'Outreach', width: 16, get: (r) => r.outreach?.stage ?? 'NOT_CONTACTED' },
  { id: 'nextFollowUpAt', label: 'Next Follow Up', group: 'Outreach', width: 20, get: (r) => iso(r.outreach?.nextFollowUpAt ?? null) },
  { id: 'tags', label: 'Tags', group: 'Outreach', width: 20, get: (r) => (r.tags.length ? r.tags.join(', ') : null) },
]

export const COLUMN_MAP = new Map(EXPORT_COLUMNS.map((c) => [c.id, c]))

export const DEFAULT_EXPORT_COLUMNS = [
  'name', 'industry', 'primaryPhone', 'primaryEmail', 'websiteUrl', 'websiteStatus',
  'addressLine', 'city', 'postalCode', 'country', 'rating', 'reviewCount',
  'leadScore', 'leadTier', 'seoHealth', 'perfScoreMobile', 'uxHealth',
  'opportunities', 'auditReasons', 'sources', 'isDemo', 'discoveredAt', 'outreachStage',
]

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null
}

export function resolveColumns(ids: string[]): ExportColumn[] {
  const requested = ids.length > 0 ? ids : DEFAULT_EXPORT_COLUMNS
  const cols = requested
    .map((id) => COLUMN_MAP.get(id))
    .filter((c): c is ExportColumn => Boolean(c))
  return cols.length > 0 ? cols : EXPORT_COLUMNS.filter((c) => DEFAULT_EXPORT_COLUMNS.includes(c.id))
}

/** Renders a cell, applying the "Not Found" rule uniformly. */
export function cellValue(col: ExportColumn, row: ExportRow): string | number {
  const v = col.get(row)
  if (v === null || v === undefined || v === '') return NOT_FOUND
  return v
}
