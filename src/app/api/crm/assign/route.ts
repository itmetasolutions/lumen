import { z } from 'zod'
import { requireRole } from '@/server/auth/guard'
import { assignLeads, unassignLeads, roundRobinAssign } from '@/server/crm/assignment'
import { compileQuery } from '@/server/filters/compile'
import { querySchema } from '@/server/filters/schema'
import { prisma } from '@/server/db/client'
import { route, HttpError } from '@/app/api/_lib/handler'

/**
 * Lead assignment.
 *
 * Three shapes, one endpoint, because they are the same decision made at
 * different scales: hand these rows to this agent, hand the current filter to
 * this agent, or spread the unassigned pool across a team. Assigning by filter
 * resolves ids through the same compiler the table uses, so "assign everything
 * I'm looking at" means exactly what is on screen (§37).
 */

const schema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('ids'),
    assignedToId: z.string().min(1).max(40),
    businessIds: z.array(z.string().max(40)).min(1).max(10_000),
    reason: z.string().max(200).optional(),
  }),
  z.object({
    mode: z.literal('filter'),
    assignedToId: z.string().min(1).max(40),
    query: querySchema,
    /** Safety rail: never assign more than this in one action. */
    limit: z.number().int().min(1).max(5_000).default(1_000),
    reason: z.string().max(200).optional(),
  }),
  z.object({
    mode: z.literal('unassign'),
    businessIds: z.array(z.string().max(40)).min(1).max(10_000),
    reason: z.string().max(200).optional(),
  }),
  z.object({
    mode: z.literal('round-robin'),
    agentIds: z.array(z.string().max(40)).min(1).max(50),
    targetPerAgent: z.number().int().min(1).max(2_000),
    limit: z.number().int().min(1).max(10_000).optional(),
  }),
])

export const POST = route({ schema, limit: 'write' }, async ({ auth, body }) => {
  // Distributing work is a supervisor action.
  requireRole(auth, 'ADMIN')

  switch (body.mode) {
    case 'ids':
      return assignLeads({
        workspaceId: auth.workspaceId,
        businessIds: body.businessIds,
        assignedToId: body.assignedToId,
        assignedById: auth.userId,
        reason: body.reason,
      })

    case 'filter': {
      const where = compileQuery(auth.workspaceId, body.query)
      const rows = await prisma.business.findMany({
        where,
        select: { id: true },
        take: body.limit,
      })
      if (rows.length === 0) throw new HttpError(400, 'That filter matches no leads')
      const result = await assignLeads({
        workspaceId: auth.workspaceId,
        businessIds: rows.map((r) => r.id),
        assignedToId: body.assignedToId,
        assignedById: auth.userId,
        method: 'rule',
        reason: body.reason,
      })
      // Say so when the safety rail truncated the selection, rather than
      // reporting a smaller number as if it were the whole filter.
      const total = await prisma.business.count({ where })
      return {
        ...result,
        reasons:
          total > rows.length
            ? [...result.reasons, `Capped at ${body.limit} of ${total} matching leads`]
            : result.reasons,
      }
    }

    case 'unassign': {
      const count = await unassignLeads({
        workspaceId: auth.workspaceId,
        businessIds: body.businessIds,
        reason: body.reason,
      })
      return { unassigned: count }
    }

    case 'round-robin':
      return roundRobinAssign({
        workspaceId: auth.workspaceId,
        assignedById: auth.userId,
        agentIds: body.agentIds,
        targetPerAgent: body.targetPerAgent,
        limit: body.limit,
      })
  }
})
