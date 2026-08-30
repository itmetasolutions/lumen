import Link from 'next/link'
import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { Badge, Button, Card, EmptyState } from '@/components/ui/primitives'
import { formatDateTime, formatNumber, freshness } from '@/lib/utils'
import { History } from 'lucide-react'

export const metadata = { title: 'Discovery Jobs' }
export const dynamic = 'force-dynamic'

/** §25 — search history with the coverage report for each run. */
export default async function JobsPage() {
  const auth = await requireAuth()

  const jobs = await prisma.discoveryJob.findMany({
    where: { workspaceId: auth.workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Discovery jobs</h1>
          <p className="mt-1 text-[13px] text-muted">
            Every search that has been run, with what it actually covered.
          </p>
        </div>
        <Link href="/discovery/new">
          <Button variant="primary" size="sm">New discovery</Button>
        </Link>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<History className="h-5 w-5" />}
            title="No discoveries yet"
            description="Run your first search to start building the lead database."
            action={
              <Link href="/discovery/new">
                <Button variant="primary">Start a discovery</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-2xs uppercase tracking-wide text-muted">
                  <th className="px-5 py-2.5 text-left font-semibold">Search</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Sources</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Queries</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Candidates</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Unique</th>
                  <th className="px-3 py-2.5 text-right font-semibold">New</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Merged</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Errors</th>
                  <th className="px-3 py-2.5 text-left font-semibold">State</th>
                  <th className="px-5 py-2.5 text-left font-semibold">Started</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="px-5 py-2.5">
                      <Link href={`/discovery/jobs/${j.id}`} className="font-medium hover:text-accent">
                        {j.name}
                      </Link>
                      <div className="text-2xs text-subtle">
                        {j.industry} · {[j.city, j.region, j.country].filter(Boolean).join(', ') || '—'} · {j.depth}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {j.providers.map((p) => (
                          <Badge key={p} tone="outline">{p}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="tnum px-3 py-2.5 text-right">{formatNumber(j.queriesExecuted)}</td>
                    <td className="tnum px-3 py-2.5 text-right">{formatNumber(j.candidatesFound)}</td>
                    <td className="tnum px-3 py-2.5 text-right font-medium">{formatNumber(j.uniqueBusinesses)}</td>
                    <td className="tnum px-3 py-2.5 text-right text-ok">{formatNumber(j.newBusinesses)}</td>
                    <td className="tnum px-3 py-2.5 text-right text-muted">{formatNumber(j.duplicatesMerged)}</td>
                    <td className={`tnum px-3 py-2.5 text-right ${j.errorCount ? 'text-danger' : 'text-muted'}`}>
                      {formatNumber(j.errorCount)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge
                        tone={
                          j.state === 'COMPLETED' ? 'ok'
                          : j.state === 'PARTIAL' ? 'warn'
                          : j.state === 'FAILED' ? 'danger'
                          : j.state === 'RUNNING' ? 'info'
                          : 'neutral'
                        }
                      >
                        {j.state === 'RUNNING' ? `${j.progressPercent}%` : j.state}
                      </Badge>
                    </td>
                    <td className="px-5 py-2.5 text-muted">
                      <div>{formatDateTime(j.startedAt ?? j.createdAt)}</div>
                      <div className="text-2xs text-subtle">{freshness(j.createdAt)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
