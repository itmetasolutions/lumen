import { z } from 'zod'
import { requireRole } from '@/server/auth/guard'
import {
  dayKey,
  generateDailyReport,
  generateWorkspaceReports,
  reportsForRange,
  summarise,
} from '@/server/crm/reports'
import { reportingTimeZone } from '@/server/crm/settings'
import { route, HttpError } from '@/app/api/_lib/handler'

/**
 * Daily reports.
 *
 * An agent may read their own days and nobody else's; a supervisor may read
 * anyone's and trigger a roll-up. The scoping is applied here rather than left
 * to the query string, so an agent passing another user id gets a 403 rather
 * than another agent's numbers.
 */

const readSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userId: z.string().max(40).optional(),
})

const writeSchema = z.object({
  action: z.enum(['generate-day', 'generate-mine']),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export const GET = route({ schema: readSchema, limit: 'read' }, async ({ auth, body }) => {
  requireRole(auth, 'AGENT')

  const isSupervisor = auth.role === 'OWNER' || auth.role === 'ADMIN'
  if (!isSupervisor && body.userId && body.userId !== auth.userId) {
    throw new HttpError(403, 'You can only read your own reports')
  }

  if (body.from > body.to) throw new HttpError(400, '"from" is after "to"')

  const rows = await reportsForRange({
    workspaceId: auth.workspaceId,
    from: body.from,
    to: body.to,
    userId: isSupervisor ? body.userId : auth.userId,
  })

  return { rows, summary: summarise(rows), timeZone: await reportingTimeZone(auth.workspaceId) }
})

export const POST = route({ schema: writeSchema, limit: 'write' }, async ({ auth, body }) => {
  requireRole(auth, 'AGENT')
  const timeZone = await reportingTimeZone(auth.workspaceId)
  const day = body.day ?? dayKey(new Date(), timeZone)

  // An agent can close out their own day; only a supervisor can roll up the
  // whole workspace.
  if (body.action === 'generate-mine') {
    return generateDailyReport({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      day,
      timeZone,
    })
  }

  requireRole(auth, 'ADMIN')
  return generateWorkspaceReports({ workspaceId: auth.workspaceId, day, timeZone })
})
