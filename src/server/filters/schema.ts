import { z } from 'zod'

/**
 * The filter DSL (§8).
 *
 * Composable AND/OR trees, validated before they touch the database. The field
 * registry below is an allowlist: a request can only filter on fields declared
 * here, which is what makes it safe to compile user input into a query.
 *
 * The same DSL drives the table, the live counts and the export — that shared
 * path is what guarantees "Export Current Filter" and the visible rows agree (§37).
 */

export const OPERATORS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'contains', 'startsWith',
  'in', 'notIn',
  'isNull', 'notNull',
  'between',
] as const

export type FilterOperator = (typeof OPERATORS)[number]

export type FieldKind = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'relation'

export interface FieldDef {
  /** Stable id used in URLs and saved views. */
  id: string
  label: string
  group: string
  kind: FieldKind
  /** Prisma column on Business, when it maps directly. */
  column?: string
  /** Fixed choices for enum fields. */
  options?: Array<{ value: string; label: string }>
  /** Operators offered in the UI for this field. */
  operators: FilterOperator[]
  /** Custom compiler for fields that need a relation query. */
  relation?: 'source' | 'outreachStage' | 'tag'
  description?: string
}

const NUM_OPS: FilterOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'notNull']
const STR_OPS: FilterOperator[] = ['eq', 'neq', 'contains', 'startsWith', 'in', 'notIn', 'isNull', 'notNull']
const BOOL_OPS: FilterOperator[] = ['eq']
const DATE_OPS: FilterOperator[] = ['gte', 'lte', 'between', 'isNull', 'notNull']

export const FIELDS: FieldDef[] = [
  // ── Location
  { id: 'country', label: 'Country', group: 'Location', kind: 'string', column: 'country', operators: STR_OPS },
  { id: 'countryCode', label: 'Country code', group: 'Location', kind: 'string', column: 'countryCode', operators: STR_OPS },
  { id: 'region', label: 'State / Region', group: 'Location', kind: 'string', column: 'region', operators: STR_OPS },
  { id: 'city', label: 'City', group: 'Location', kind: 'string', column: 'city', operators: STR_OPS },
  { id: 'area', label: 'Area / Neighbourhood', group: 'Location', kind: 'string', column: 'area', operators: STR_OPS },
  { id: 'postalCode', label: 'Postal code', group: 'Location', kind: 'string', column: 'postalCode', operators: STR_OPS },

  // ── Business
  { id: 'name', label: 'Business name', group: 'Business', kind: 'string', column: 'name', operators: STR_OPS },
  { id: 'industry', label: 'Industry', group: 'Business', kind: 'string', column: 'industry', operators: STR_OPS },
  { id: 'category', label: 'Category', group: 'Business', kind: 'string', column: 'category', operators: STR_OPS },
  { id: 'rating', label: 'Rating', group: 'Business', kind: 'number', column: 'rating', operators: NUM_OPS },
  { id: 'reviewCount', label: 'Review count', group: 'Business', kind: 'number', column: 'reviewCount', operators: NUM_OPS },
  {
    id: 'openingStatus',
    label: 'Business status',
    group: 'Business',
    kind: 'enum',
    column: 'openingStatus',
    operators: ['eq', 'neq', 'in', 'isNull'],
    options: [
      { value: 'OPERATIONAL', label: 'Operational' },
      { value: 'CLOSED_TEMPORARILY', label: 'Temporarily closed' },
      { value: 'CLOSED_PERMANENTLY', label: 'Permanently closed' },
    ],
  },
  {
    id: 'auditStatus',
    label: 'Audit status',
    group: 'Business',
    kind: 'enum',
    column: 'auditStatus',
    operators: ['eq', 'neq', 'in'],
    options: [
      { value: 'NOT_AUDITED', label: 'Not audited' },
      { value: 'QUEUED', label: 'Queued' },
      { value: 'RUNNING', label: 'Running' },
      { value: 'COMPLETED', label: 'Completed' },
      { value: 'PARTIAL', label: 'Partial' },
      { value: 'FAILED', label: 'Failed' },
      { value: 'SKIPPED', label: 'Skipped' },
    ],
  },
  // ── Contact
  { id: 'hasPhone', label: 'Has phone', group: 'Contact', kind: 'boolean', column: 'hasPhone', operators: BOOL_OPS },
  { id: 'hasEmail', label: 'Has email', group: 'Contact', kind: 'boolean', column: 'hasEmail', operators: BOOL_OPS },
  { id: 'hasWebsite', label: 'Has website', group: 'Contact', kind: 'boolean', column: 'hasWebsite', operators: BOOL_OPS },
  { id: 'hasSocial', label: 'Has social profile', group: 'Contact', kind: 'boolean', column: 'hasSocial', operators: BOOL_OPS },
  {
    id: 'websiteStatus',
    label: 'Website status',
    group: 'Contact',
    kind: 'enum',
    column: 'websiteStatus',
    operators: ['eq', 'neq', 'in'],
    options: [
      { value: 'UNKNOWN', label: 'Not checked' },
      { value: 'NONE', label: 'No website' },
      { value: 'REACHABLE', label: 'Reachable' },
      { value: 'UNREACHABLE', label: 'Unreachable' },
      { value: 'PARKED', label: 'Parked' },
      { value: 'SOCIAL_ONLY', label: 'Social only' },
    ],
  },

  // ── SEO
  { id: 'seoHealth', label: 'SEO health score', group: 'SEO', kind: 'number', column: 'seoHealth', operators: NUM_OPS },
  { id: 'seoOpp', label: 'SEO opportunity score', group: 'SEO', kind: 'number', column: 'seoOpp', operators: NUM_OPS },
  { id: 'seoIssueCount', label: 'SEO issue count', group: 'SEO', kind: 'number', column: 'seoIssueCount', operators: NUM_OPS },
  { id: 'seoMissingTitle', label: 'Missing title', group: 'SEO', kind: 'boolean', column: 'seoMissingTitle', operators: BOOL_OPS },
  { id: 'seoMissingDescription', label: 'Missing meta description', group: 'SEO', kind: 'boolean', column: 'seoMissingDescription', operators: BOOL_OPS },
  { id: 'seoMissingH1', label: 'Missing H1', group: 'SEO', kind: 'boolean', column: 'seoMissingH1', operators: BOOL_OPS },
  { id: 'seoNoSitemap', label: 'No XML sitemap', group: 'SEO', kind: 'boolean', column: 'seoNoSitemap', operators: BOOL_OPS },
  { id: 'seoNoSchema', label: 'No structured data', group: 'SEO', kind: 'boolean', column: 'seoNoSchema', operators: BOOL_OPS },
  { id: 'seoNotIndexable', label: 'Indexability problem', group: 'SEO', kind: 'boolean', column: 'seoNotIndexable', operators: BOOL_OPS },
  { id: 'brokenLinkCount', label: 'Broken links', group: 'SEO', kind: 'number', column: 'brokenLinkCount', operators: NUM_OPS },

  // ── Speed
  { id: 'perfScoreMobile', label: 'Mobile performance score', group: 'Speed', kind: 'number', column: 'perfScoreMobile', operators: NUM_OPS },
  { id: 'perfScoreDesktop', label: 'Desktop performance score', group: 'Speed', kind: 'number', column: 'perfScoreDesktop', operators: NUM_OPS },
  { id: 'lcpMobileMs', label: 'Mobile LCP (ms)', group: 'Speed', kind: 'number', column: 'lcpMobileMs', operators: NUM_OPS },
  { id: 'clsMobile', label: 'Mobile CLS', group: 'Speed', kind: 'number', column: 'clsMobile', operators: NUM_OPS },
  { id: 'inpMobileMs', label: 'INP (ms, field data)', group: 'Speed', kind: 'number', column: 'inpMobileMs', operators: NUM_OPS },
  { id: 'pageWeightBytes', label: 'Page weight (bytes)', group: 'Speed', kind: 'number', column: 'pageWeightBytes', operators: NUM_OPS },
  { id: 'speedOpp', label: 'Speed opportunity score', group: 'Speed', kind: 'number', column: 'speedOpp', operators: NUM_OPS },

  // ── UX / UI
  { id: 'uxHealth', label: 'UX health score', group: 'UX/UI', kind: 'number', column: 'uxHealth', operators: NUM_OPS },
  { id: 'redesignOpp', label: 'Redesign opportunity score', group: 'UX/UI', kind: 'number', column: 'redesignOpp', operators: NUM_OPS },
  { id: 'uxNoViewport', label: 'Not mobile responsive', group: 'UX/UI', kind: 'boolean', column: 'uxNoViewport', operators: BOOL_OPS, description: 'No viewport meta tag — the page does not adapt to phones.' },
  { id: 'uxHorizontalOverflow', label: 'Broken mobile layout', group: 'UX/UI', kind: 'boolean', column: 'uxHorizontalOverflow', operators: BOOL_OPS, description: 'Page scrolls sideways at 390px.' },
  { id: 'uxBrokenImages', label: 'Broken images', group: 'UX/UI', kind: 'number', column: 'uxBrokenImages', operators: NUM_OPS },
  { id: 'uxAccessibilityIssues', label: 'Accessibility issues', group: 'UX/UI', kind: 'number', column: 'uxAccessibilityIssues', operators: NUM_OPS },
  { id: 'uxNavigationIssues', label: 'Navigation issues', group: 'UX/UI', kind: 'number', column: 'uxNavigationIssues', operators: NUM_OPS },
  { id: 'techNoHttps', label: 'No HTTPS', group: 'UX/UI', kind: 'boolean', column: 'techNoHttps', operators: BOOL_OPS },
  { id: 'techMixedContent', label: 'Mixed content', group: 'UX/UI', kind: 'boolean', column: 'techMixedContent', operators: BOOL_OPS },
  { id: 'technicalHealth', label: 'Technical health score', group: 'UX/UI', kind: 'number', column: 'technicalHealth', operators: NUM_OPS },

  // ── Opportunity
  { id: 'needsWebsite', label: 'Needs website', group: 'Opportunity', kind: 'boolean', column: 'needsWebsite', operators: BOOL_OPS },
  { id: 'needsRedesign', label: 'Needs redesign', group: 'Opportunity', kind: 'boolean', column: 'needsRedesign', operators: BOOL_OPS },
  { id: 'needsSeo', label: 'Needs SEO', group: 'Opportunity', kind: 'boolean', column: 'needsSeo', operators: BOOL_OPS },
  { id: 'needsSpeed', label: 'Needs speed work', group: 'Opportunity', kind: 'boolean', column: 'needsSpeed', operators: BOOL_OPS },
  { id: 'websiteCreationOpp', label: 'Website creation score', group: 'Opportunity', kind: 'number', column: 'websiteCreationOpp', operators: NUM_OPS },

  // ── Lead quality
  { id: 'leadScore', label: 'Lead score', group: 'Lead quality', kind: 'number', column: 'leadScore', operators: NUM_OPS },
  {
    id: 'leadTier',
    label: 'Lead tier',
    group: 'Lead quality',
    kind: 'enum',
    column: 'leadTier',
    operators: ['eq', 'neq', 'in'],
    options: [
      { value: 'HOT', label: 'Hot' },
      { value: 'WARM', label: 'Warm' },
      { value: 'LOW', label: 'Low' },
    ],
  },
  { id: 'dataConfidence', label: 'Data confidence', group: 'Lead quality', kind: 'number', column: 'dataConfidence', operators: NUM_OPS },
  { id: 'websiteHealth', label: 'Website health score', group: 'Lead quality', kind: 'number', column: 'websiteHealth', operators: NUM_OPS },

  // ── Dates
  { id: 'discoveredAt', label: 'Date discovered', group: 'Dates', kind: 'date', column: 'discoveredAt', operators: DATE_OPS },
  { id: 'lastAuditedAt', label: 'Last audited', group: 'Dates', kind: 'date', column: 'lastAuditedAt', operators: DATE_OPS },
  { id: 'lastSeenAt', label: 'Last seen', group: 'Dates', kind: 'date', column: 'lastSeenAt', operators: DATE_OPS },
  { id: 'lastPerfAuditAt', label: 'Last performance test', group: 'Dates', kind: 'date', column: 'lastPerfAuditAt', operators: DATE_OPS },
  { id: 'lastSeoAuditAt', label: 'Last SEO audit', group: 'Dates', kind: 'date', column: 'lastSeoAuditAt', operators: DATE_OPS },

  // ── Source & outreach (relations)
  {
    id: 'source',
    label: 'Discovery source',
    group: 'Source',
    kind: 'relation',
    relation: 'source',
    operators: ['eq', 'in', 'neq'],
    options: [
      { value: 'google-places', label: 'Google Places' },
      { value: 'openstreetmap', label: 'OpenStreetMap' },
      { value: 'search', label: 'SerpApi Google Maps' },
      { value: 'serpapi-yelp', label: 'SerpApi Yelp' },
      { value: 'serpapi-yandex', label: 'SerpApi Yandex' },
      { value: 'csv-import', label: 'CSV import' },
    ],
  },
  {
    id: 'outreachStage',
    label: 'Contact status',
    group: 'Outreach',
    kind: 'relation',
    relation: 'outreachStage',
    operators: ['eq', 'in', 'neq'],
    options: [
      { value: 'NOT_CONTACTED', label: 'Not contacted' },
      { value: 'CONTACTED', label: 'Contacted' },
      { value: 'FOLLOW_UP', label: 'Follow up' },
      { value: 'INTERESTED', label: 'Interested' },
      { value: 'QUALIFIED', label: 'Qualified' },
      { value: 'PROPOSAL_SENT', label: 'Proposal sent' },
      { value: 'WON', label: 'Won' },
      { value: 'LOST', label: 'Lost' },
      { value: 'NOT_INTERESTED', label: 'Not interested' },
      { value: 'DO_NOT_CONTACT', label: 'Do not contact' },
    ],
  },
  {
    id: 'tag',
    label: 'Tag',
    group: 'Outreach',
    kind: 'relation',
    relation: 'tag',
    operators: ['eq', 'in'],
  },
]

export const FIELD_MAP = new Map(FIELDS.map((f) => [f.id, f]))

// ── zod schema ────────────────────────────────────────────────────────────────

const conditionSchema = z.object({
  field: z.string().refine((f) => FIELD_MAP.has(f), {
    message: 'Unknown filter field',
  }),
  op: z.enum(OPERATORS),
  value: z.unknown().optional(),
})

export type FilterCondition = z.infer<typeof conditionSchema>

export interface FilterGroup {
  logic: 'AND' | 'OR'
  conditions: Array<FilterCondition | FilterGroup>
}

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    logic: z.enum(['AND', 'OR']),
    conditions: z
      .array(z.union([conditionSchema, filterGroupSchema]))
      // Bounded so a hostile payload cannot build a pathological query tree.
      .max(50),
  }),
)

export const EMPTY_FILTER: FilterGroup = { logic: 'AND', conditions: [] }

export function isGroup(node: FilterCondition | FilterGroup): node is FilterGroup {
  return 'logic' in node && 'conditions' in node
}

export const TABS = [
  'all',
  'website-creation',
  'redesign',
  'seo',
  'speed',
  'hot',
  'new',
] as const

export type TabId = (typeof TABS)[number]

export const TAB_LABELS: Record<TabId, string> = {
  all: 'All Businesses',
  'website-creation': 'Website Creation',
  redesign: 'Website Redesign',
  seo: 'SEO',
  speed: 'Speed Optimization',
  hot: 'Hot Leads',
  new: 'New Leads',
}

export const SORTABLE = [
  'leadScore', 'seoHealth', 'seoOpp', 'perfScoreMobile', 'perfScoreDesktop',
  'uxHealth', 'websiteHealth', 'rating', 'reviewCount', 'discoveredAt',
  'lastAuditedAt', 'name', 'city', 'redesignOpp', 'speedOpp', 'websiteCreationOpp',
  'dataConfidence',
] as const

export const sortSchema = z.object({
  field: z.enum(SORTABLE),
  direction: z.enum(['asc', 'desc']),
})

export type SortSpec = z.infer<typeof sortSchema>

export const DATE_PRESETS = [
  'today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'custom', 'all',
] as const

export type DatePreset = (typeof DATE_PRESETS)[number]

export const dateRangeSchema = z.object({
  preset: z.enum(DATE_PRESETS).default('all'),
  field: z.enum(['discoveredAt', 'lastAuditedAt', 'lastSeenAt', 'createdAt']).default('discoveredAt'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

export type DateRange = z.infer<typeof dateRangeSchema>

export const querySchema = z.object({
  tab: z.enum(TABS).default('all'),
  filters: filterGroupSchema.default(EMPTY_FILTER),
  search: z.string().max(200).optional(),
  sort: sortSchema.default({ field: 'leadScore', direction: 'desc' }),
  dateRange: dateRangeSchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
})

export type LeadQuery = z.infer<typeof querySchema>
