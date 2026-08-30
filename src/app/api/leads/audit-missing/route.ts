import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { requireRole } from '@/server/auth/guard'
import { querySchema } from '@/server/filters/schema'
import { queueMissingAudits, MAX_AUDIT_BATCH } from '@/server/leads/audit-queue'
import { route } from '@/app/api/_lib/handler'

/**
 * Queues audits for businesses that have never been audited.
 *
 * `dryRun` exists so the UI can state the real number before the user commits —
 * queueing several hundred audits is hours of crawling, and a confirmation that
 * says "this will audit 148 businesses" is worth the extra round trip.
 */

const schema = z.object({
  query: querySchema.optional(),
  depth: z.enum(['QUICK', 'STANDARD', 'DEEP']).default('STANDARD'),
  includeFailed: z.boolean().default(false),
  limit: z.number().int().min(1).max(MAX_AUDIT_BATCH).optional(),
  dryRun: z.boolean().default(false),
})

export const POST = route({ schema, limit: 'expensive' }, async ({ auth, body }) => {
  requireRole(auth, 'MEMBER')

  const result = await queueMissingAudits({
    workspaceId: auth.workspaceId,
    query: body.query,
    depth: body.depth,
    includeFailed: body.includeFailed,
    limit: body.limit,
    dryRun: body.dryRun,
  })

  if (!body.dryRun && result.queued > 0) {
    await prisma.auditLog.create({
      data: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        action: 'leads.audit_missing',
        meta: {
          queued: result.queued,
          matched: result.matched,
          depth: body.depth,
          includeFailed: body.includeFailed,
        },
      },
    })
  }

  return result
})
