import { z } from 'zod'
import { requireRole } from '@/server/auth/guard'
import { liveAgents } from '@/server/crm/sessions'
import { dayKey, dayRange } from '@/server/crm/reports'
import { reportingTimeZone } from '@/server/crm/settings'
import { prisma } from '@/server/db/client'
import { route } from '@/app/api/_lib/handler'

/**
 * The live supervisor view.
 *
 * Polled every few seconds by the floor page, so it is deliberately cheap: a
 * fixed number of grouped queries regardless of headcount, and no per-agent
 * round trips. Rate-limited as a read for the same reason.
 */

const schema = z.object({
  /** Recent calls to include alongside the agent roster. */
  recent: z.coerce.number().int().min(0).max(50).default(15),
})

export const GET = route({ schema, limit: 'read' }, async ({ auth, body }) => {
  requireRole(auth, 'ADMIN')

  const timeZone = await reportingTimeZone(auth.workspaceId)
  const day = dayKey(new Date(), timeZone)
  const { start } = dayRange(day, timeZone)

  const [agents, recentCalls, totals] = await Promise.all([
    liveAgents(auth.workspaceId, start),
    body.recent === 0
      ? []
      : prisma.callLog.findMany({
          where: { workspaceId: auth.workspaceId, createdAt: { gte: start } },
          orderBy: { createdAt: 'desc' },
          take: body.recent,
          select: {
            id: true,
            outcome: true,
            contactReached: true,
            createdAt: true,
            durationSec: true,
            business: { select: { id: true, name: true } },
            user: { select: { id: true, name: true, email: true } },
          },
        }),
    prisma.callLog.groupBy({
      by: ['contactReached'],
      where: { workspaceId: auth.workspaceId, createdAt: { gte: start } },
      _count: { _all: true },
    }),
  ])

  const calls = totals.reduce((n, r) => n + r._count._all, 0)
  const reached = totals.find((r) => r.contactReached)?._count._all ?? 0

  return {
    day,
    timeZone,
    agents,
    recentCalls,
    today: {
      calls,
      reached,
      contactRate: calls > 0 ? Math.round((reached / calls) * 100) : null,
      online: agents.filter((a) => a.status === 'online').length,
      clockedIn: agents.filter((a) => a.clockedInAt !== null).length,
    },
    // The client renders relative times ("14s ago"); giving it the server's
    // clock keeps those honest when the two machines disagree.
    serverTime: new Date().toISOString(),
  }
})
