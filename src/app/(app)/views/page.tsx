import Link from 'next/link'
import { Bookmark } from 'lucide-react'
import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { Badge, Button, Card, EmptyState } from '@/components/ui/primitives'
import { TAB_LABELS, type TabId } from '@/server/filters/schema'
import { formatDateTime } from '@/lib/utils'

export const metadata = { title: 'Saved Views' }
export const dynamic = 'force-dynamic'

export default async function ViewsPage() {
  const auth = await requireAuth()

  const views = await prisma.savedView.findMany({
    where: { workspaceId: auth.workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: { createdBy: { select: { name: true, email: true } } },
  })

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Saved views</h1>
        <p className="mt-1 text-[13px] text-muted">
          Each view stores a tab, its filters, sort order, visible columns and date range.
        </p>
      </div>

      {views.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bookmark className="h-5 w-5" />}
            title="No saved views"
            description="Build a filter on any leads tab and choose Save view. Useful for recurring segments like “London dentists — no website”."
            action={
              <Link href="/leads/all">
                <Button variant="primary">Go to leads</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {views.map((v) => {
            const conditions = countConditions(v.filters)
            return (
              <Link key={v.id} href={`/leads/${v.tab}`}>
                <Card className="h-full px-4 py-3.5 transition-colors hover:border-accent/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold">{v.name}</div>
                      <div className="mt-0.5 text-2xs text-subtle">
                        Updated {formatDateTime(v.updatedAt)} · by{' '}
                        {v.createdBy?.name ?? v.createdBy?.email ?? 'unknown'}
                      </div>
                    </div>
                    <Badge tone="accent">{TAB_LABELS[v.tab as TabId] ?? v.tab}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge tone="outline">{conditions} condition{conditions === 1 ? '' : 's'}</Badge>
                    <Badge tone="outline">{v.columns.length} columns</Badge>
                    {v.isShared && <Badge tone="outline">shared</Badge>}
                  </div>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Counts leaf conditions in a stored filter tree without trusting its shape. */
function countConditions(filters: unknown): number {
  if (!filters || typeof filters !== 'object') return 0
  const group = filters as { conditions?: unknown[] }
  if (!Array.isArray(group.conditions)) return 0
  return group.conditions.reduce<number>(
    (n, node) =>
      n +
      (node && typeof node === 'object' && 'conditions' in (node as object)
        ? countConditions(node)
        : 1),
    0,
  )
}
