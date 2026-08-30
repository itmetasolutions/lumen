import { z } from 'zod'
import { requireRole } from '@/server/auth/guard'
import {
  COMMON_TIME_ZONES,
  crmSettings,
  isValidTimeZone,
  updateCrmSettings,
} from '@/server/crm/settings'
import { route, HttpError } from '@/app/api/_lib/handler'

/** Calling-operation policy: day boundary, auto-assignment, lead reclaim. */

const schema = z.object({
  reportingTimeZone: z.string().max(64).optional(),
  reportingHour: z.number().int().min(0).max(23).optional(),
  autoAssignEnabled: z.boolean().optional(),
  autoAssignTarget: z.number().int().min(1).max(2_000).optional(),
  reclaimEnabled: z.boolean().optional(),
  reclaimStaleDays: z.number().int().min(1).max(365).optional(),
  requireClockIn: z.boolean().optional(),
})

export const GET = route({ limit: 'read' }, async ({ auth }) => {
  requireRole(auth, 'ADMIN')
  return { settings: await crmSettings(auth.workspaceId), timeZones: COMMON_TIME_ZONES }
})

export const POST = route({ schema, limit: 'write' }, async ({ auth, body }) => {
  requireRole(auth, 'ADMIN')

  if (body.reportingTimeZone && !isValidTimeZone(body.reportingTimeZone)) {
    throw new HttpError(400, `"${body.reportingTimeZone}" is not a recognised timezone`)
  }

  return { settings: await updateCrmSettings(auth.workspaceId, body) }
})
