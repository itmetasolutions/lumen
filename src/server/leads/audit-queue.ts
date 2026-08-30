import 'server-only'
import { prisma } from '@/server/db/client'
import type { Prisma } from '@prisma/client'
import { getQueue } from '@/server/queue'
import { compileQuery } from '@/server/filters/compile'
import type { LeadQuery } from '@/server/filters/schema'
import type { AuditDepth } from '@prisma/client'

/**
 * Bulk audit queueing.
 *
 * Discovery queues an audit for everything it finds, but records can end up
 * unaudited anyway: a job was cancelled, a worker was down, a CSV of businesses
 * arrived, or an earlier audit failed outright. This is the catch-up.
 *
 * Two properties matter. It must not double-queue work already in flight, and it
 * must report what it is about to do *before* doing it — several hundred audits
 * is real crawling, real PageSpeed calls and real time.
 */

/** Statuses that mean "no usable audit exists". */
const UNAUDITED: Prisma.EnumAuditStatusFilter['in'] = ['NOT_AUDITED']
const FAILED_TOO: Prisma.EnumAuditStatusFilter['in'] = ['NOT_AUDITED', 'FAILED']

export const DEFAULT_AUDIT_BATCH = 1_000
export const MAX_AUDIT_BATCH = 10_000

export interface QueueAuditsInput {
  workspaceId: string
  /** Restrict to the user's current filter; omitted means the whole workspace. */
  query?: LeadQuery
  depth?: AuditDepth
  /** Re-attempt records whose previous audit failed. */
  includeFailed?: boolean
  limit?: number
  /** Report what would happen without enqueueing anything. */
  dryRun?: boolean
}

export interface QueueAuditsResult {
  matched: number
  withWebsite: number
  withoutWebsite: number
  queued: number
  capped: boolean
  limit: number
  dryRun: boolean
}

export function unauditedWhere(
  workspaceId: string,
  query: LeadQuery | undefined,
  includeFailed: boolean,
): Prisma.BusinessWhereInput {
  const base = query ? compileQuery(workspaceId, query) : { workspaceId }
  return {
    AND: [
      base,
      // QUEUED and RUNNING are deliberately excluded: those already have a job.
      { auditStatus: { in: includeFailed ? FAILED_TOO : UNAUDITED } },
    ],
  }
}

export async function queueMissingAudits(
  input: QueueAuditsInput,
): Promise<QueueAuditsResult> {
  const limit = Math.min(MAX_AUDIT_BATCH, Math.max(1, input.limit ?? DEFAULT_AUDIT_BATCH))
  const includeFailed = input.includeFailed ?? false
  const depth = input.depth ?? 'STANDARD'
  const where = unauditedWhere(input.workspaceId, input.query, includeFailed)

  const [matched, withWebsite] = await Promise.all([
    prisma.business.count({ where }),
    prisma.business.count({ where: { AND: [where, { hasWebsite: true }] } }),
  ])

  const result: QueueAuditsResult = {
    matched,
    withWebsite,
    withoutWebsite: matched - withWebsite,
    queued: 0,
    capped: matched > limit,
    limit,
    dryRun: input.dryRun ?? false,
  }

  if (input.dryRun || matched === 0) return result

  // Websites first: those produce the audit findings the opportunity tabs need.
  // Records without one still get queued — the pipeline scores them as
  // website-creation leads — but they are cheap and can wait.
  const rows = await prisma.business.findMany({
    where,
    select: { id: true },
    orderBy: [{ hasWebsite: 'desc' }, { leadScore: 'desc' }, { id: 'asc' }],
    take: limit,
  })

  if (rows.length === 0) return result

  const queue = getQueue()
  result.queued = await queue.enqueueMany(
    'audit.site',
    rows.map((r) => ({
      businessId: r.id,
      workspaceId: input.workspaceId,
      depth,
      trigger: 'recheck' as const,
    })),
  )

  // Mark them queued so a second click does not enqueue the same work again.
  await prisma.business.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { auditStatus: 'QUEUED' },
  })

  return result
}
