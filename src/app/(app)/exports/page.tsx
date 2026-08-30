import Link from 'next/link'
import { Download, FileDown } from 'lucide-react'
import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { Badge, Button, Card, EmptyState } from '@/components/ui/primitives'
import { formatBytes, formatDateTime, formatNumber } from '@/lib/utils'

export const metadata = { title: 'Exports' }
export const dynamic = 'force-dynamic'

export default async function ExportsPage() {
  const auth = await requireAuth()

  const jobs = await prisma.exportJob.findMany({
    where: { workspaceId: auth.workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { createdBy: { select: { name: true, email: true } } },
  })

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Exports</h1>
        <p className="mt-1 text-[13px] text-muted">
          Files are generated server-side and served only to members of this workspace.
        </p>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileDown className="h-5 w-5" />}
            title="No exports yet"
            description="Export from any leads tab — you can export everything, exactly the current filter, or only the rows you selected."
            action={
              <Link href="/leads/all">
                <Button variant="primary">Go to All Businesses</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-2xs uppercase tracking-wide text-muted">
                <th className="px-5 py-2.5 text-left font-semibold">File</th>
                <th className="px-3 py-2.5 text-left font-semibold">Tab</th>
                <th className="px-3 py-2.5 text-left font-semibold">Scope</th>
                <th className="px-3 py-2.5 text-right font-semibold">Rows</th>
                <th className="px-3 py-2.5 text-right font-semibold">Size</th>
                <th className="px-3 py-2.5 text-left font-semibold">Created</th>
                <th className="px-5 py-2.5 text-right font-semibold">State</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-2.5">
                    <div className="font-medium">{j.fileName ?? `${j.format} export`}</div>
                    {j.error && <div className="text-2xs text-danger">{j.error}</div>}
                    <div className="text-2xs text-subtle">
                      {j.columns.length} fields · by {j.createdBy?.name ?? j.createdBy?.email ?? 'unknown'}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">{j.tab}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone="outline">
                      {j.scope === 'FILTER' ? 'Current filter' : j.scope === 'SELECTED' ? 'Selected rows' : 'All in tab'}
                    </Badge>
                  </td>
                  <td className="tnum px-3 py-2.5 text-right font-medium">{formatNumber(j.rowCount)}</td>
                  <td className="tnum px-3 py-2.5 text-right text-muted">{j.bytes ? formatBytes(j.bytes) : '—'}</td>
                  <td className="px-3 py-2.5 text-muted">{formatDateTime(j.createdAt)}</td>
                  <td className="px-5 py-2.5 text-right">
                    {j.state === 'COMPLETED' ? (
                      <a href={`/api/export/${j.id}/download`} download>
                        <Button size="sm" variant="secondary">
                          <Download className="h-3.5 w-3.5" />
                          Download
                        </Button>
                      </a>
                    ) : (
                      <Badge
                        tone={j.state === 'FAILED' ? 'danger' : j.state === 'RUNNING' ? 'info' : 'neutral'}
                      >
                        {j.state}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
