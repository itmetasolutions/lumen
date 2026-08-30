import 'server-only'
import { prisma } from '@/server/db/client'

/**
 * Workspace-level CRM policy.
 *
 * These are the knobs that change how the calling operation runs — the day
 * boundary reports are cut on, whether leads are handed out automatically, when
 * an untouched lead goes back in the pool. They live on `WorkspaceSettings`
 * rather than in environment variables because two workspaces in one
 * installation legitimately run on different timezones and different rules.
 */

export interface CrmSettings {
  reportingTimeZone: string
  reportingHour: number
  autoAssignEnabled: boolean
  autoAssignTarget: number
  reclaimEnabled: boolean
  reclaimStaleDays: number
  requireClockIn: boolean
}

export const CRM_DEFAULTS: CrmSettings = {
  reportingTimeZone: 'UTC',
  reportingHour: 22,
  autoAssignEnabled: false,
  autoAssignTarget: 40,
  reclaimEnabled: false,
  reclaimStaleDays: 14,
  requireClockIn: true,
}

export async function crmSettings(workspaceId: string): Promise<CrmSettings> {
  const row = await prisma.workspaceSettings.findUnique({
    where: { workspaceId },
    select: {
      reportingTimeZone: true,
      reportingHour: true,
      autoAssignEnabled: true,
      autoAssignTarget: true,
      reclaimEnabled: true,
      reclaimStaleDays: true,
      requireClockIn: true,
    },
  })
  return row ?? CRM_DEFAULTS
}

/**
 * Validates against the runtime's own timezone database rather than a hardcoded
 * list, so anything the reporting code can format is accepted and nothing else.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function reportingTimeZone(workspaceId: string): Promise<string> {
  const { reportingTimeZone: tz } = await crmSettings(workspaceId)
  return isValidTimeZone(tz) ? tz : 'UTC'
}

export async function updateCrmSettings(
  workspaceId: string,
  patch: Partial<CrmSettings>,
): Promise<CrmSettings> {
  if (patch.reportingTimeZone && !isValidTimeZone(patch.reportingTimeZone)) {
    throw new Error(`Unknown timezone: ${patch.reportingTimeZone}`)
  }

  const saved = await prisma.workspaceSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, ...patch },
    update: patch,
    select: {
      reportingTimeZone: true,
      reportingHour: true,
      autoAssignEnabled: true,
      autoAssignTarget: true,
      reclaimEnabled: true,
      reclaimStaleDays: true,
      requireClockIn: true,
    },
  })
  return saved
}

/**
 * Timezones offered in the settings UI.
 *
 * A short, honest list beats an unfiltered dump of every IANA zone: these cover
 * the regions this product is actually used from, and the field accepts any
 * valid zone typed in directly.
 */
export const COMMON_TIME_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Istanbul',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Manila',
  'Asia/Tokyo',
  'Australia/Perth',
  'Australia/Sydney',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Africa/Cairo',
]
