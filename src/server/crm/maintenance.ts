import 'server-only'
import { prisma } from '@/server/db/client'
import { crmSettings } from './settings'
import { dayKey, generateWorkspaceReports } from './reports'
import { closeAbandonedSessions } from './sessions'
import { reclaimStaleLeads, roundRobinAssign } from './assignment'
import type { JobContext } from '@/server/queue/types'

/**
 * The unattended half of the CRM.
 *
 * Everything here is work a supervisor would otherwise have to remember to do:
 * closing shifts people forgot to end, rolling the day up into reports,
 * returning leads nobody is calling, and topping agents back up to their target
 * queue size. It runs on a tick rather than a cron expression so the worker can
 * be stopped for a day and still catch up — every step is idempotent and
 * decides for itself whether it is due.
 *
 * The tick is intentionally dumb; the *rules* live in the workspace's settings,
 * so two workspaces on different timezones and different policies share this
 * one code path without special cases.
 */

export interface MaintenanceResult {
  workspaceId: string
  day: string
  timeZone: string
  closedSessions: number
  reportsGenerated: number
  reportsCatchUp: number
  leadsReclaimed: number
  leadsAssigned: number
  skipped: string[]
}

export async function runCrmMaintenance(
  payload: { workspaceId: string; force?: boolean },
  ctx?: Pick<JobContext, 'log'>,
): Promise<MaintenanceResult> {
  const { workspaceId } = payload
  const settings = await crmSettings(workspaceId)
  const tz = settings.reportingTimeZone
  const now = new Date()
  const day = dayKey(now, tz)
  const skipped: string[] = []
  const log = (m: string) => ctx?.log?.(`[crm] ${m}`)

  // 1. Shifts left open. Done first so the shift minutes in any report written
  //    below reflect work rather than an app someone left running.
  const closedSessions = await closeAbandonedSessions({ workspaceId, olderThanHours: 16 })
  if (closedSessions > 0) log(`closed ${closedSessions} abandoned shift(s)`)

  // 2. Yesterday's report, if the worker was not running when the day ended.
  //    Reports are snapshots, so a missing day stays missing until someone
  //    writes it — catching up here is what makes the history complete.
  const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000), tz)
  let reportsCatchUp = 0
  const haveYesterday = await prisma.dailyReport.count({ where: { workspaceId, day: yesterday } })
  if (haveYesterday === 0) {
    const res = await generateWorkspaceReports({ workspaceId, day: yesterday, timeZone: tz })
    reportsCatchUp = res.generated
    if (res.generated > 0) log(`caught up ${res.generated} report(s) for ${yesterday}`)
  }

  // 3. Today's report, once the working day is over.
  const localHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false })
      .format(now)
      .replace(/[^0-9]/g, ''),
  )
  let reportsGenerated = 0
  if (payload.force || localHour >= settings.reportingHour) {
    const res = await generateWorkspaceReports({ workspaceId, day, timeZone: tz })
    reportsGenerated = res.generated
    log(`rolled up ${res.generated} report(s) for ${day}`)
  } else {
    skipped.push(`Day-end roll-up runs after ${settings.reportingHour}:00 ${tz}`)
  }

  // 4. Leads that have sat untouched go back to the pool.
  let leadsReclaimed = 0
  if (settings.reclaimEnabled) {
    const res = await reclaimStaleLeads({ workspaceId, staleDays: settings.reclaimStaleDays })
    leadsReclaimed = res.count
    if (res.count > 0) log(`reclaimed ${res.count} stale lead(s)`)
  } else {
    skipped.push('Stale-lead reclaim is off')
  }

  // 5. Top agents back up. Runs after the reclaim so leads freed a moment ago
  //    are available to hand out in the same pass.
  let leadsAssigned = 0
  if (settings.autoAssignEnabled) {
    const agents = await prisma.membership.findMany({
      where: { workspaceId, role: { in: ['AGENT', 'MEMBER'] }, user: { isActive: true } },
      select: { userId: true },
    })
    if (agents.length === 0) {
      skipped.push('Auto-assignment is on but the workspace has no active agents')
    } else {
      const actor = await supervisorId(workspaceId)
      const res = await roundRobinAssign({
        workspaceId,
        assignedById: actor,
        agentIds: agents.map((a) => a.userId),
        targetPerAgent: settings.autoAssignTarget,
      })
      leadsAssigned = res.assigned
      if (res.assigned > 0) log(`auto-assigned ${res.assigned} lead(s)`)
      else if (res.reasons.length > 0) skipped.push(...res.reasons)
    }
  } else {
    skipped.push('Auto-assignment is off')
  }

  return {
    workspaceId,
    day,
    timeZone: tz,
    closedSessions,
    reportsGenerated,
    reportsCatchUp,
    leadsReclaimed,
    leadsAssigned,
    skipped,
  }
}

/**
 * Automated assignments are still attributed to a person — the workspace owner.
 * An assignment history with a null actor would leave "who gave me this lead?"
 * unanswerable, which is the question the history exists to answer.
 */
async function supervisorId(workspaceId: string): Promise<string> {
  const owner = await prisma.membership.findFirst({
    where: { workspaceId, role: { in: ['OWNER', 'ADMIN'] }, user: { isActive: true } },
    orderBy: { role: 'asc' },
    select: { userId: true },
  })
  if (owner) return owner.userId
  const any = await prisma.membership.findFirst({ where: { workspaceId }, select: { userId: true } })
  if (!any) throw new Error('Workspace has no members')
  return any.userId
}

/** Queue handler signature. */
export async function runCrmMaintenanceJob(
  payload: { workspaceId: string; force?: boolean },
  ctx: JobContext,
): Promise<void> {
  const result = await runCrmMaintenance(payload, ctx)
  ctx.log('[crm] maintenance complete', result)
}

/**
 * Workspaces that should be ticked.
 *
 * Only those with people who could be calling — a workspace with no agents has
 * nothing to roll up, and ticking it every few minutes would be pure noise in
 * the job table.
 */
export async function workspacesNeedingMaintenance(): Promise<string[]> {
  const rows = await prisma.membership.findMany({
    where: { role: { in: ['AGENT', 'MEMBER', 'ADMIN', 'OWNER'] } },
    select: { workspaceId: true },
    distinct: ['workspaceId'],
  })
  return rows.map((r) => r.workspaceId)
}
