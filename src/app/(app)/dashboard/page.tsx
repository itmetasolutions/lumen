import Link from 'next/link'
import {
  Database, Globe, PaintRoller, TrendingUp, Gauge, Flame, Sparkles,
  ArrowUpRight, Rocket, Server,
} from 'lucide-react'
import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { Badge, Button, Card, CardHeader, EmptyState } from '@/components/ui/primitives'
import { BarList, Donut, Histogram, LineChart } from '@/components/charts'
import { formatDateTime, formatNumber, freshness } from '@/lib/utils'

export const metadata = { title: 'Dashboard' }
export const dynamic = 'force-dynamic'

/**
 * Executive dashboard (§23).
 *
 * Every number here is a live aggregate over the workspace — nothing is
 * precomputed or sampled, and nothing is invented for the sake of a full-looking
 * chart. An empty workspace says so.
 */
export default async function DashboardPage() {
  const auth = await requireAuth()
  const ws = auth.workspaceId

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const thirtyDaysAgo = new Date(Date.now() - 29 * 86_400_000)
  thirtyDaysAgo.setHours(0, 0, 0, 0)

  const [
    total, noWebsite, redesign, seo, speed, hot, newToday,
    byIndustry, byCity, leadBuckets, seoBuckets, perfBuckets,
    recentJobs, recentAudits, recentExports, discoveredSeries, auditedCount,
  ] = await Promise.all([
    prisma.business.count({ where: { workspaceId: ws } }),
    prisma.business.count({ where: { workspaceId: ws, needsWebsite: true } }),
    prisma.business.count({ where: { workspaceId: ws, needsRedesign: true } }),
    prisma.business.count({ where: { workspaceId: ws, needsSeo: true } }),
    prisma.business.count({ where: { workspaceId: ws, needsSpeed: true } }),
    prisma.business.count({ where: { workspaceId: ws, leadTier: 'HOT' } }),
    prisma.business.count({
      where: { workspaceId: ws, discoveredAt: { gte: startOfToday } },
    }),

    prisma.business.groupBy({
      by: ['industry'],
      where: { workspaceId: ws, industry: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { industry: 'desc' } },
      take: 7,
    }),
    prisma.business.groupBy({
      by: ['city'],
      where: { workspaceId: ws, city: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { city: 'desc' } },
      take: 7,
    }),

    bucketCounts(ws, 'leadScore'),
    bucketCounts(ws, 'seoHealth'),
    bucketCounts(ws, 'perfScoreMobile'),

    prisma.discoveryJob.findMany({
      where: { workspaceId: ws },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true, name: true, state: true, industry: true, city: true,
        uniqueBusinesses: true, newBusinesses: true, createdAt: true,
        progressPercent: true,
      },
    }),
    prisma.audit.findMany({
      where: { business: { workspaceId: ws } },
      orderBy: { startedAt: 'desc' },
      take: 6,
      select: {
        id: true, status: true, startedAt: true, isDemo: true,
        business: { select: { id: true, name: true } },
        _count: { select: { issues: true } },
      },
    }),
    prisma.exportJob.findMany({
      where: { workspaceId: ws },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true, format: true, scope: true, tab: true, state: true,
        rowCount: true, createdAt: true,
      },
    }),

    prisma.business.findMany({
      where: { workspaceId: ws, discoveredAt: { gte: thirtyDaysAgo } },
      select: { discoveredAt: true },
    }),
    prisma.business.count({
      where: { workspaceId: ws, lastAuditedAt: { not: null } },
    }),
  ])

  if (total === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <EmptyState
          icon={<Rocket className="h-5 w-5" />}
          title="Your lead database is empty"
          description={
            <>
              Run a discovery to find businesses in a market, audit their websites and
              surface the opportunities. OpenStreetMap works without any API key, so you
              can start with real data immediately.
            </>
          }
          action={
            <div className="flex gap-2">
              <Link href="/discovery/new">
                <Button variant="primary">Start a discovery</Button>
              </Link>
              <Link href="/settings/connections">
                <Button variant="secondary">Add connections</Button>
              </Link>
            </div>
          }
        />
      </div>
    )
  }

  const series = buildDailySeries(discoveredSeries.map((b) => b.discoveredAt), 30)

  return (
    <div className="space-y-5 px-6 py-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-[13px] text-muted">
            {formatNumber(total)} businesses ·{' '}
            {formatNumber(auditedCount)} audited ·{' '}
            {formatNumber(total - auditedCount)} awaiting audit
          </p>
        </div>
        <Link href="/discovery/new">
          <Button variant="primary" size="sm">
            <Rocket className="h-3.5 w-3.5" />
            New discovery
          </Button>
        </Link>
      </div>

      {/* ── Cards ────────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard href="/leads/all" icon={Database} label="Businesses" value={total} />
        <StatCard href="/leads/website-creation" icon={Globe} label="No website" value={noWebsite} tone="danger" />
        <StatCard href="/leads/redesign" icon={PaintRoller} label="Redesign" value={redesign} tone="warn" />
        <StatCard href="/leads/seo" icon={TrendingUp} label="SEO" value={seo} tone="info" />
        <StatCard href="/leads/speed" icon={Gauge} label="Speed" value={speed} tone="accent" />
        <StatCard href="/leads/hot" icon={Flame} label="Hot leads" value={hot} tone="danger" />
        <StatCard href="/leads/new" icon={Sparkles} label="New today" value={newToday} tone="ok" />
      </div>

      {/* ── Charts ───────────────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="New businesses discovered"
            description="Last 30 days, by the date a business was first seen"
          />
          <div className="px-4 py-4">
            <LineChart points={series} height={160} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Opportunities" description="Businesses can appear in several" />
          <div className="px-5 py-5">
            <Donut
              data={[
                { label: 'Website creation', value: noWebsite, color: 'hsl(var(--danger))' },
                { label: 'Redesign', value: redesign, color: 'hsl(var(--warn))' },
                { label: 'SEO', value: seo, color: 'hsl(var(--info))' },
                { label: 'Speed', value: speed, color: 'hsl(var(--accent))' },
              ]}
              centerValue={formatNumber(noWebsite + redesign + seo + speed)}
              centerLabel="flags"
            />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Lead score distribution" description="Higher is a better prospect" />
          <div className="px-5 py-5">
            <Histogram buckets={leadBuckets} />
          </div>
        </Card>
        <Card>
          <CardHeader title="SEO health distribution" description="Lower means more to fix" />
          <div className="px-5 py-5">
            <Histogram buckets={seoBuckets} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Mobile performance" description="Lighthouse score, mobile" />
          <div className="px-5 py-5">
            <Histogram buckets={perfBuckets} />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Businesses by industry" />
          <div className="px-5 py-4">
            <BarList
              data={byIndustry.map((r) => ({
                label: r.industry ?? 'Unknown',
                value: r._count._all,
              }))}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Businesses by location" />
          <div className="px-5 py-4">
            <BarList
              data={byCity.map((r) => ({ label: r.city ?? 'Unknown', value: r._count._all }))}
            />
          </div>
        </Card>
      </div>

      {/* ── Recent activity ──────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Recent discovery jobs"
            actions={
              <Link href="/discovery/jobs" className="text-2xs text-accent hover:underline">
                View all
              </Link>
            }
          />
          <ul className="divide-y divide-border">
            {recentJobs.length === 0 && <Empty>No discoveries yet</Empty>}
            {recentJobs.map((j) => (
              <li key={j.id}>
                <Link
                  href={`/discovery/jobs/${j.id}`}
                  className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{j.name}</div>
                    <div className="text-2xs text-subtle">
                      {formatNumber(j.uniqueBusinesses)} unique ·{' '}
                      {formatNumber(j.newBusinesses)} new · {freshness(j.createdAt)}
                    </div>
                  </div>
                  <JobStateBadge state={j.state} percent={j.progressPercent} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader
            title="Recent audits"
            actions={
              <Link href="/audits" className="text-2xs text-accent hover:underline">
                View all
              </Link>
            }
          />
          <ul className="divide-y divide-border">
            {recentAudits.length === 0 && <Empty>No audits yet</Empty>}
            {recentAudits.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/businesses/${a.business.id}`}
                  className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">
                        {a.business.name}
                      </span>
                      {a.isDemo && <Badge tone="demo">DEMO</Badge>}
                    </div>
                    <div className="text-2xs text-subtle">
                      {a._count.issues} findings · {freshness(a.startedAt)}
                    </div>
                  </div>
                  <Badge
                    tone={
                      a.status === 'COMPLETED' ? 'ok'
                      : a.status === 'PARTIAL' ? 'warn'
                      : a.status === 'FAILED' ? 'danger'
                      : 'neutral'
                    }
                  >
                    {a.status}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader
            title="Recent exports"
            actions={
              <Link href="/exports" className="text-2xs text-accent hover:underline">
                View all
              </Link>
            }
          />
          <ul className="divide-y divide-border">
            {recentExports.length === 0 && <Empty>No exports yet</Empty>}
            {recentExports.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {e.tab} · {e.format}
                  </div>
                  <div className="text-2xs text-subtle">
                    {formatNumber(e.rowCount)} rows · {e.scope.toLowerCase()} ·{' '}
                    {freshness(e.createdAt)}
                  </div>
                </div>
                <Badge
                  tone={
                    e.state === 'COMPLETED' ? 'ok' : e.state === 'FAILED' ? 'danger' : 'neutral'
                  }
                >
                  {e.state}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

const BANDS = [
  { label: '0–19', from: 0, to: 19 },
  { label: '20–39', from: 20, to: 39 },
  { label: '40–59', from: 40, to: 59 },
  { label: '60–79', from: 60, to: 79 },
  { label: '80–100', from: 80, to: 100 },
]

async function bucketCounts(
  workspaceId: string,
  field: 'leadScore' | 'seoHealth' | 'perfScoreMobile',
) {
  const counts = await Promise.all(
    BANDS.map((b) =>
      prisma.business.count({
        where: { workspaceId, [field]: { gte: b.from, lte: b.to } },
      }),
    ),
  )
  return BANDS.map((b, i) => ({ label: b.label, value: counts[i]!, from: b.from }))
}

function buildDailySeries(dates: Date[], days: number) {
  const byDay = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    byDay.set(d.toISOString().slice(0, 10), 0)
  }
  for (const d of dates) {
    const key = d.toISOString().slice(0, 10)
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + 1)
  }
  return Array.from(byDay.entries()).map(([day, value]) => ({
    label: day.slice(5),
    value,
  }))
}

function StatCard({
  href,
  icon: Icon,
  label,
  value,
  tone,
}: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number
  tone?: 'ok' | 'warn' | 'danger' | 'info' | 'accent'
}) {
  const color =
    tone === 'ok' ? 'text-ok'
    : tone === 'warn' ? 'text-warn'
    : tone === 'danger' ? 'text-danger'
    : tone === 'info' ? 'text-info'
    : tone === 'accent' ? 'text-accent'
    : 'text-fg'

  return (
    <Link href={href} className="group panel px-4 py-3 transition-colors hover:border-accent/40">
      <div className="flex items-center justify-between">
        <Icon className="h-4 w-4 text-subtle" />
        <ArrowUpRight className="h-3.5 w-3.5 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className={`tnum mt-2 text-2xl font-semibold tracking-tight ${color}`}>
        {formatNumber(value)}
      </div>
      <div className="mt-0.5 text-2xs text-muted">{label}</div>
    </Link>
  )
}

function JobStateBadge({ state, percent }: { state: string; percent: number }) {
  if (state === 'RUNNING') return <Badge tone="info">{percent}%</Badge>
  const tone =
    state === 'COMPLETED' ? 'ok'
    : state === 'PARTIAL' ? 'warn'
    : state === 'FAILED' ? 'danger'
    : 'neutral'
  return <Badge tone={tone as never}>{state}</Badge>
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 px-5 py-4 text-[13px] text-subtle">
      <Server className="h-3.5 w-3.5" />
      {children}
    </li>
  )
}
