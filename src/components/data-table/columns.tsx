'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Badge, ScorePill } from '@/components/ui/primitives'
import { NOT_FOUND, formatBytes, formatDate, formatMs, formatNumber } from '@/lib/utils'
import type { LeadRow } from '@/server/leads/query'

/**
 * Table column registry (§6, §22).
 *
 * Columns are declared once and referenced by id everywhere: the visibility
 * menu, saved views and the default sets per tab. `sortField` is only set where
 * the underlying column is indexed and sortable server-side.
 */

export interface ColumnDef {
  id: string
  label: string
  group: string
  width: number
  align?: 'left' | 'right'
  sortField?: string
  /** Columns pinned into the default set for a particular tab. */
  render: (row: LeadRow) => React.ReactNode
}

function Missing() {
  return <span className="text-2xs text-subtle">{NOT_FOUND}</span>
}

function tierTone(tier: string | null) {
  return tier === 'HOT' ? 'danger' : tier === 'WARM' ? 'warn' : 'neutral'
}

export const COLUMNS: ColumnDef[] = [
  {
    id: 'name',
    label: 'Business',
    group: 'Business',
    width: 280,
    sortField: 'name',
    render: (r) => (
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href={`/businesses/${r.id}`}
          className="truncate font-medium text-fg hover:text-accent hover:underline"
        >
          {r.name}
        </Link>
        {r.isDemo && <Badge tone="demo">DEMO</Badge>}
      </div>
    ),
  },
  {
    id: 'industry',
    label: 'Industry',
    group: 'Business',
    width: 140,
    render: (r) => r.industry ?? <Missing />,
  },
  {
    id: 'category',
    label: 'Category',
    group: 'Business',
    width: 150,
    render: (r) => r.category ?? <Missing />,
  },
  {
    id: 'website',
    label: 'Website',
    group: 'Website',
    width: 220,
    render: (r) =>
      r.websiteUrl ? (
        <a
          href={r.websiteUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1 truncate text-accent hover:underline"
        >
          <span className="truncate">{r.websiteDomain ?? r.websiteUrl}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
        </a>
      ) : (
        <Missing />
      ),
  },
  {
    id: 'websiteStatus',
    label: 'Website Status',
    group: 'Website',
    width: 130,
    render: (r) => {
      const tone =
        r.websiteStatus === 'REACHABLE'
          ? 'ok'
          : r.websiteStatus === 'NONE'
            ? 'danger'
            : r.websiteStatus === 'UNREACHABLE'
              ? 'warn'
              : 'neutral'
      const label =
        {
          UNKNOWN: 'Not checked',
          NONE: 'No website',
          REACHABLE: 'Reachable',
          UNREACHABLE: 'Unreachable',
          PARKED: 'Parked',
          SOCIAL_ONLY: 'Social only',
          ERROR: 'Error',
        }[r.websiteStatus] ?? r.websiteStatus
      return <Badge tone={tone}>{label}</Badge>
    },
  },
  {
    id: 'phone',
    label: 'Phone',
    group: 'Contact',
    width: 150,
    render: (r) =>
      r.primaryPhone ? (
        <a href={`tel:${r.primaryPhone}`} className="tnum hover:text-accent">
          {r.primaryPhone}
        </a>
      ) : (
        <Missing />
      ),
  },
  {
    id: 'email',
    label: 'Email',
    group: 'Contact',
    width: 210,
    render: (r) =>
      r.primaryEmail ? (
        <a href={`mailto:${r.primaryEmail}`} className="truncate hover:text-accent">
          {r.primaryEmail}
        </a>
      ) : (
        <Missing />
      ),
  },
  {
    id: 'address',
    label: 'Address',
    group: 'Location',
    width: 240,
    render: (r) => r.addressLine ?? <Missing />,
  },
  { id: 'city', label: 'City', group: 'Location', width: 130, sortField: 'city', render: (r) => r.city ?? <Missing /> },
  { id: 'region', label: 'Region', group: 'Location', width: 130, render: (r) => r.region ?? <Missing /> },
  { id: 'postalCode', label: 'Postcode', group: 'Location', width: 100, render: (r) => r.postalCode ?? <Missing /> },
  { id: 'country', label: 'Country', group: 'Location', width: 120, render: (r) => r.country ?? <Missing /> },
  {
    id: 'rating',
    label: 'Rating',
    group: 'Reputation',
    width: 90,
    align: 'right',
    sortField: 'rating',
    render: (r) =>
      r.rating === null ? <Missing /> : <span className="tnum">{r.rating.toFixed(1)}★</span>,
  },
  {
    id: 'reviewCount',
    label: 'Reviews',
    group: 'Reputation',
    width: 90,
    align: 'right',
    sortField: 'reviewCount',
    render: (r) => (r.reviewCount === null ? <Missing /> : <span className="tnum">{formatNumber(r.reviewCount)}</span>),
  },
  {
    id: 'leadScore',
    label: 'Lead Score',
    group: 'Scores',
    width: 130,
    sortField: 'leadScore',
    render: (r) => (
      <div className="flex items-center gap-2">
        <ScorePill score={r.leadScore} />
        {r.leadTier && <Badge tone={tierTone(r.leadTier)}>{r.leadTier}</Badge>}
      </div>
    ),
  },
  {
    id: 'seoHealth',
    label: 'SEO Health',
    group: 'Scores',
    width: 115,
    sortField: 'seoHealth',
    render: (r) => <ScorePill score={r.seoHealth} />,
  },
  {
    id: 'perfMobile',
    label: 'Speed (Mobile)',
    group: 'Scores',
    width: 130,
    sortField: 'perfScoreMobile',
    render: (r) => <ScorePill score={r.perfScoreMobile} />,
  },
  {
    id: 'perfDesktop',
    label: 'Speed (Desktop)',
    group: 'Scores',
    width: 135,
    sortField: 'perfScoreDesktop',
    render: (r) => <ScorePill score={r.perfScoreDesktop} />,
  },
  {
    id: 'uxHealth',
    label: 'UX/UI Health',
    group: 'Scores',
    width: 120,
    sortField: 'uxHealth',
    render: (r) => <ScorePill score={r.uxHealth} />,
  },
  {
    id: 'technicalHealth',
    label: 'Technical',
    group: 'Scores',
    width: 110,
    render: (r) => <ScorePill score={r.technicalHealth} />,
  },
  {
    id: 'websiteHealth',
    label: 'Website Health',
    group: 'Scores',
    width: 130,
    sortField: 'websiteHealth',
    render: (r) => <ScorePill score={r.websiteHealth} />,
  },
  {
    id: 'opportunities',
    label: 'Opportunities',
    group: 'Opportunity',
    width: 230,
    render: (r) => {
      const items: Array<[boolean, string, string]> = [
        [r.needsWebsite, 'Website', 'danger'],
        [r.needsRedesign, 'Redesign', 'warn'],
        [r.needsSeo, 'SEO', 'info'],
        [r.needsSpeed, 'Speed', 'accent'],
      ]
      const active = items.filter(([on]) => on)
      if (active.length === 0) return <span className="text-2xs text-subtle">None</span>
      return (
        <div className="flex flex-wrap gap-1">
          {active.map(([, label, tone]) => (
            <Badge key={label} tone={tone as never}>
              {label}
            </Badge>
          ))}
        </div>
      )
    },
  },
  {
    id: 'seoOpp',
    label: 'SEO Opportunity',
    group: 'Opportunity',
    width: 135,
    sortField: 'seoOpp',
    render: (r) => <ScorePill score={r.seoOpp} inverted />,
  },
  {
    id: 'speedOpp',
    label: 'Speed Opportunity',
    group: 'Opportunity',
    width: 145,
    sortField: 'speedOpp',
    render: (r) => <ScorePill score={r.speedOpp} inverted />,
  },
  {
    id: 'redesignOpp',
    label: 'Redesign Opportunity',
    group: 'Opportunity',
    width: 160,
    sortField: 'redesignOpp',
    render: (r) => <ScorePill score={r.redesignOpp} inverted />,
  },
  {
    id: 'lcpMobile',
    label: 'Mobile LCP',
    group: 'Evidence',
    width: 105,
    align: 'right',
    render: (r) => (r.lcpMobileMs === null ? <Missing /> : <span className="tnum">{formatMs(r.lcpMobileMs)}</span>),
  },
  {
    id: 'clsMobile',
    label: 'Mobile CLS',
    group: 'Evidence',
    width: 100,
    align: 'right',
    render: (r) => (r.clsMobile === null ? <Missing /> : <span className="tnum">{r.clsMobile.toFixed(3)}</span>),
  },
  {
    id: 'issueCounts',
    label: 'Issues',
    group: 'Evidence',
    width: 150,
    render: (r) => {
      const parts: string[] = []
      if (r.seoIssueCount) parts.push(`${r.seoIssueCount} SEO`)
      if (r.uxIssueCount) parts.push(`${r.uxIssueCount} UX`)
      if (r.brokenLinkCount) parts.push(`${r.brokenLinkCount} links`)
      if (r.uxBrokenImages) parts.push(`${r.uxBrokenImages} images`)
      return parts.length ? (
        <span className="text-2xs text-muted">{parts.join(' · ')}</span>
      ) : (
        <span className="text-2xs text-subtle">—</span>
      )
    },
  },
  {
    id: 'sources',
    label: 'Sources',
    group: 'Provenance',
    width: 170,
    render: (r) =>
      r.sources.length === 0 ? (
        <Missing />
      ) : (
        <div className="flex flex-wrap gap-1">
          {r.sources.map((s) => (
            <Badge key={s.provider} tone={s.isDemo ? 'demo' : 'outline'}>
              {SOURCE_LABELS[s.provider] ?? s.provider}
            </Badge>
          ))}
        </div>
      ),
  },
  {
    id: 'auditStatus',
    label: 'Audit',
    group: 'Provenance',
    width: 110,
    render: (r) => {
      const tone =
        r.auditStatus === 'COMPLETED'
          ? 'ok'
          : r.auditStatus === 'PARTIAL'
            ? 'warn'
            : r.auditStatus === 'FAILED'
              ? 'danger'
              : 'neutral'
      return <Badge tone={tone}>{r.auditStatus.replace('_', ' ')}</Badge>
    },
  },
  {
    id: 'discoveredAt',
    label: 'Date Found',
    group: 'Dates',
    width: 120,
    sortField: 'discoveredAt',
    render: (r) => <span className="tnum text-muted">{formatDate(r.discoveredAt)}</span>,
  },
  {
    id: 'lastAuditedAt',
    label: 'Last Audited',
    group: 'Dates',
    width: 120,
    sortField: 'lastAuditedAt',
    render: (r) => <span className="tnum text-muted">{formatDate(r.lastAuditedAt)}</span>,
  },
  {
    id: 'outreach',
    label: 'Contact Status',
    group: 'Outreach',
    width: 140,
    render: (r) => {
      const stage = r.outreach?.stage ?? 'NOT_CONTACTED'
      const tone =
        stage === 'WON' ? 'ok'
        : stage === 'DO_NOT_CONTACT' || stage === 'LOST' ? 'danger'
        : stage === 'NOT_CONTACTED' ? 'neutral'
        : 'info'
      return <Badge tone={tone}>{STAGE_LABELS[stage] ?? stage}</Badge>
    },
  },
]

export const SOURCE_LABELS: Record<string, string> = {
  'google-places': 'Google',
  openstreetmap: 'OSM',
  search: 'Serp Maps',
  'serpapi-yelp': 'Serp Yelp',
  'serpapi-yandex': 'Serp Yandex',
  'csv-import': 'CSV',
  'website-crawl': 'Website',
  mock: 'Demo',
}

export const STAGE_LABELS: Record<string, string> = {
  NOT_CONTACTED: 'Not contacted',
  CONTACTED: 'Contacted',
  FOLLOW_UP: 'Follow up',
  INTERESTED: 'Interested',
  QUALIFIED: 'Qualified',
  PROPOSAL_SENT: 'Proposal sent',
  WON: 'Won',
  LOST: 'Lost',
  NOT_INTERESTED: 'Not interested',
  DO_NOT_CONTACT: 'Do not contact',
}

export const COLUMN_MAP = new Map(COLUMNS.map((c) => [c.id, c]))

/** Sensible default column sets per tab — each tab leads with its own evidence. */
export const DEFAULT_COLUMNS: Record<string, string[]> = {
  all: ['name', 'industry', 'website', 'websiteStatus', 'phone', 'email', 'city', 'rating', 'reviewCount', 'leadScore', 'opportunities', 'sources', 'discoveredAt'],
  'website-creation': ['name', 'industry', 'phone', 'email', 'address', 'city', 'rating', 'reviewCount', 'leadScore', 'sources', 'discoveredAt', 'outreach'],
  redesign: ['name', 'website', 'uxHealth', 'redesignOpp', 'issueCounts', 'phone', 'email', 'city', 'leadScore', 'opportunities', 'lastAuditedAt'],
  seo: ['name', 'website', 'seoHealth', 'seoOpp', 'issueCounts', 'phone', 'email', 'city', 'rating', 'reviewCount', 'leadScore', 'lastAuditedAt'],
  speed: ['name', 'website', 'perfMobile', 'perfDesktop', 'lcpMobile', 'clsMobile', 'speedOpp', 'phone', 'city', 'leadScore', 'lastAuditedAt'],
  hot: ['name', 'industry', 'website', 'phone', 'email', 'city', 'rating', 'reviewCount', 'leadScore', 'opportunities', 'outreach'],
  new: ['name', 'industry', 'website', 'websiteStatus', 'phone', 'email', 'city', 'leadScore', 'opportunities', 'sources', 'discoveredAt'],
}

export function defaultColumnsFor(tab: string): string[] {
  return DEFAULT_COLUMNS[tab] ?? DEFAULT_COLUMNS.all!
}
