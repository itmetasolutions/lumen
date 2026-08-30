import 'server-only'
import { prisma } from '@/server/db/client'
import type { Prisma } from '@prisma/client'
import { compileQuery, compileOrderBy, tabWhere } from '@/server/filters/compile'
import { TABS, type LeadQuery, type TabId } from '@/server/filters/schema'

/**
 * Server-side list, count and profile queries (§22, §36, §39).
 *
 * Everything is paginated and filtered in Postgres. The browser never receives
 * more than one page of rows — the brief is explicit that loading 100,000 rows
 * client-side is not acceptable, and at that size it simply does not work.
 */

export const LEAD_ROW_SELECT = {
  id: true,
  name: true,
  industry: true,
  category: true,
  websiteUrl: true,
  websiteDomain: true,
  websiteStatus: true,
  primaryPhone: true,
  primaryEmail: true,
  addressLine: true,
  city: true,
  region: true,
  country: true,
  postalCode: true,
  latitude: true,
  longitude: true,
  rating: true,
  reviewCount: true,
  openingStatus: true,
  leadScore: true,
  leadTier: true,
  dataConfidence: true,
  websiteHealth: true,
  seoHealth: true,
  uxHealth: true,
  technicalHealth: true,
  perfScoreMobile: true,
  perfScoreDesktop: true,
  seoOpp: true,
  speedOpp: true,
  redesignOpp: true,
  websiteCreationOpp: true,
  needsWebsite: true,
  needsRedesign: true,
  needsSeo: true,
  needsSpeed: true,
  seoIssueCount: true,
  uxIssueCount: true,
  brokenLinkCount: true,
  uxBrokenImages: true,
  lcpMobileMs: true,
  clsMobile: true,
  hasPhone: true,
  hasEmail: true,
  hasWebsite: true,
  hasSocial: true,
  isDemo: true,
  auditStatus: true,
  discoveredAt: true,
  lastAuditedAt: true,
  lastSeenAt: true,
  tags: true,
  sources: { select: { provider: true, isDemo: true } },
  outreach: { select: { stage: true, nextFollowUpAt: true } },
} satisfies Prisma.BusinessSelect

export type LeadRow = Prisma.BusinessGetPayload<{ select: typeof LEAD_ROW_SELECT }>

export interface LeadPage {
  rows: LeadRow[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export async function listLeads(
  workspaceId: string,
  query: LeadQuery,
): Promise<LeadPage> {
  const where = compileQuery(workspaceId, query)

  const [rows, total] = await Promise.all([
    prisma.business.findMany({
      where,
      select: LEAD_ROW_SELECT,
      orderBy: compileOrderBy(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.business.count({ where }),
  ])

  return {
    rows,
    total,
    page: query.page,
    pageSize: query.pageSize,
    pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
  }
}

export type TabCounts = Record<TabId, number>

/**
 * §36 — live counts per tab, evaluated under the *current* filter context so the
 * numbers answer "how many of my filtered set fall into each opportunity", not
 * "how many exist overall". The tab predicate is swapped; every other part of
 * the query is held constant.
 */
export async function tabCounts(
  workspaceId: string,
  query: LeadQuery,
  opts: { applyFilters?: boolean } = {},
): Promise<TabCounts> {
  const applyFilters = opts.applyFilters ?? true

  const base = applyFilters
    ? compileQuery(workspaceId, { ...query, tab: 'all' })
    : ({ workspaceId } as Prisma.BusinessWhereInput)

  const entries = await Promise.all(
    TABS.map(async (tab) => {
      const where: Prisma.BusinessWhereInput = { AND: [base, tabWhere(tab)] }
      const count = await prisma.business.count({ where })
      return [tab, count] as const
    }),
  )

  return Object.fromEntries(entries) as TabCounts
}

/** Counts for the sidebar: unfiltered, workspace-wide. */
export async function sidebarCounts(workspaceId: string): Promise<TabCounts> {
  const [all, websiteCreation, redesign, seo, speed, hot] = await Promise.all([
    prisma.business.count({ where: { workspaceId } }),
    prisma.business.count({ where: { workspaceId, needsWebsite: true } }),
    prisma.business.count({ where: { workspaceId, needsRedesign: true } }),
    prisma.business.count({ where: { workspaceId, needsSeo: true } }),
    prisma.business.count({ where: { workspaceId, needsSpeed: true } }),
    prisma.business.count({ where: { workspaceId, leadTier: 'HOT' } }),
  ])

  const since = new Date()
  since.setDate(since.getDate() - 6)
  since.setHours(0, 0, 0, 0)
  const newLeads = await prisma.business.count({
    where: { workspaceId, discoveredAt: { gte: since } },
  })

  return {
    all,
    'website-creation': websiteCreation,
    redesign,
    seo,
    speed,
    hot,
    new: newLeads,
  }
}

/** Every id matching the current filter — used by "select all matching". */
export async function matchingIds(
  workspaceId: string,
  query: LeadQuery,
  limit = 10_000,
): Promise<string[]> {
  const rows = await prisma.business.findMany({
    where: compileQuery(workspaceId, query),
    select: { id: true },
    orderBy: compileOrderBy(query.sort),
    take: limit,
  })
  return rows.map((r) => r.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Business profile (§10)
// ─────────────────────────────────────────────────────────────────────────────

export async function getBusinessProfile(workspaceId: string, id: string) {
  return prisma.business.findFirst({
    where: { id, workspaceId },
    include: {
      sources: { orderBy: { retrievedAt: 'desc' } },
      contacts: { orderBy: [{ isPrimary: 'desc' }, { kind: 'asc' }] },
      website: true,
      opportunities: true,
      outreach: { include: { notes: { orderBy: { createdAt: 'desc' }, take: 50 } } },
      audits: {
        orderBy: { startedAt: 'desc' },
        take: 12,
        include: {
          issues: { orderBy: [{ severity: 'asc' }, { category: 'asc' }] },
          seoResult: true,
          uxResult: { include: { screenshots: true } },
          technical: true,
          performance: true,
          pages: { orderBy: { fetchedAt: 'asc' } },
        },
      },
    },
  })
}

export type BusinessProfile = NonNullable<Awaited<ReturnType<typeof getBusinessProfile>>>

/**
 * §26 — historical comparison. Returns each completed audit's score snapshot so
 * the profile can show "Performance: 38 on 1 June → 72 on 1 July (+34)".
 */
export async function auditHistory(workspaceId: string, businessId: string) {
  return prisma.audit.findMany({
    where: {
      businessId,
      business: { workspaceId },
      status: { in: ['COMPLETED', 'PARTIAL'] },
    },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      startedAt: true,
      completedAt: true,
      status: true,
      depth: true,
      trigger: true,
      isDemo: true,
      websiteHealth: true,
      seoHealth: true,
      uxHealth: true,
      technicalHealth: true,
      perfHealthMobile: true,
      perfHealthDesktop: true,
      leadScore: true,
      _count: { select: { issues: true } },
    },
  })
}
