import { NextResponse } from 'next/server'
import { prisma } from '@/server/db/client'
import { requireApiAuth } from '@/server/auth/guard'
import { errorResponse } from '@/app/api/_lib/handler'

/**
 * Job status + recent events. Polled by the wizard's live progress view, so it
 * is kept deliberately small and index-friendly.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireApiAuth()
    const { id } = await params

    const job = await prisma.discoveryJob.findFirst({
      where: { id, workspaceId: auth.workspaceId },
      include: {
        events: { orderBy: { createdAt: 'desc' }, take: 40 },
        _count: { select: { queries: true } },
      },
    })
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const [queryStats, auditsPending, auditsDone] = await Promise.all([
      prisma.searchQuery.groupBy({
        by: ['status'],
        where: { jobId: id },
        _count: { _all: true },
      }),
      prisma.business.count({
        where: {
          workspaceId: auth.workspaceId,
          sources: { some: { jobId: id } },
          auditStatus: { in: ['QUEUED', 'RUNNING'] },
        },
      }),
      prisma.business.count({
        where: {
          workspaceId: auth.workspaceId,
          sources: { some: { jobId: id } },
          auditStatus: { in: ['COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED'] },
        },
      }),
    ])

    return NextResponse.json({
      job: {
        ...job,
        events: job.events.reverse(),
      },
      queryStats: Object.fromEntries(queryStats.map((q) => [q.status, q._count._all])),
      audits: { pending: auditsPending, done: auditsDone },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
