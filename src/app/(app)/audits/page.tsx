import Link from 'next/link'
import { ClipboardCheck } from 'lucide-react'
import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { Badge, Card, CardHeader, EmptyState, ScorePill } from '@/components/ui/primitives'
import { formatDateTime, formatMs, formatNumber, freshness } from '@/lib/utils'

export const metadata = { title: 'Recent Audits' }
export const dynamic = 'force-dynamic'

/** §32 — recent audits plus the re-check queue (records with stale audits). */
export default async function AuditsPage() {
  const auth = await requireAuth()
  const ws = auth.workspaceId

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)

  const [recent, staleCount, stale, never] = await Promise.all([
    prisma.audit.findMany({
      where: { business: { workspaceId: ws } },
      orderBy: { startedAt: 'desc' },
      take: 40,
      include: {
        business: { select: { id: true, name: true, websiteDomain: true } },
        _count: { select: { issues: true } },
      },
    }),
    prisma.business.count({
      where: { workspaceId: ws, hasWebsite: true, lastAuditedAt: { lt: thirtyDaysAgo } },
    }),
    prisma.business.findMany({
      where: { workspaceId: ws, hasWebsite: true, lastAuditedAt: { lt: thirtyDaysAgo } },
      orderBy: { lastAuditedAt: 'asc' },
      take: 20,
      select: { id: true, name: true, websiteDomain: true, lastAuditedAt: true, leadScore: true },
    }),
    prisma.business.count({
      where: { workspaceId: ws, hasWebsite: true, lastAuditedAt: null },
    }),
  ])

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Audits</h1>
        <p className="mt-1 text-[13px] text-muted">
          Audits are append-only — a re-audit adds a record rather than replacing one.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="Recent audits" description={`${recent.length} most recent runs`} />
          {recent.length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck className="h-5 w-5" />}
              title="No audits yet"
              description="Audits are queued automatically after a discovery finds businesses with websites."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-surface-2 text-2xs uppercase tracking-wide text-muted">
                    <th className="px-5 py-2.5 text-left font-semibold">Business</th>
                    <th className="px-3 py-2.5 text-left font-semibold">Stages</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Findings</th>
                    <th className="px-3 py-2.5 text-left font-semibold">Health</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Duration</th>
                    <th className="px-5 py-2.5 text-left font-semibold">When</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="px-5 py-2.5">
                        <Link href={`/businesses/${a.business.id}`} className="font-medium hover:text-accent">
                          {a.business.name}
                        </Link>
                        <div className="text-2xs text-subtle">{a.business.websiteDomain ?? '—'}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <StageChip label="crawl" status={a.crawlStatus} />
                          <StageChip label="seo" status={a.seoStatus} />
                          <StageChip label="perf" status={a.performanceStatus} />
                          <StageChip label="ux" status={a.uxStatus} />
                          <StageChip label="tech" status={a.technicalStatus} />
                        </div>
                      </td>
                      <td className="tnum px-3 py-2.5 text-right">{a._count.issues}</td>
                      <td className="px-3 py-2.5"><ScorePill score={a.websiteHealth} /></td>
                      <td className="tnum px-3 py-2.5 text-right text-muted">{formatMs(a.durationMs)}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
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
                          {a.isDemo && <Badge tone="demo">DEMO</Badge>}
                        </div>
                        <div className="mt-0.5 text-2xs text-subtle">{formatDateTime(a.startedAt)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Re-check queue"
            description="Websites change. These records are due another look."
          />
          <div className="grid grid-cols-2 gap-px border-b border-border bg-border">
            <div className="bg-surface px-4 py-3">
              <div className="tnum text-xl font-semibold text-warn">{formatNumber(staleCount)}</div>
              <div className="text-2xs text-muted">Audited over 30 days ago</div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="tnum text-xl font-semibold">{formatNumber(never)}</div>
              <div className="text-2xs text-muted">Has a website, never audited</div>
            </div>
          </div>
          <ul className="divide-y divide-border">
            {stale.length === 0 && (
              <li className="px-5 py-4 text-[13px] text-muted">Nothing is overdue.</li>
            )}
            {stale.map((b) => (
              <li key={b.id}>
                <Link href={`/businesses/${b.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{b.name}</div>
                    <div className="text-2xs text-subtle">
                      {b.websiteDomain} · audited {freshness(b.lastAuditedAt)}
                    </div>
                  </div>
                  <ScorePill score={b.leadScore} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function StageChip({ label, status }: { label: string; status: string }) {
  const tone =
    status === 'OK' ? 'ok'
    : status === 'FAILED' ? 'danger'
    : status === 'SKIPPED' ? 'neutral'
    : 'info'
  return <Badge tone={tone as never} title={`${label}: ${status}`}>{label}</Badge>
}
