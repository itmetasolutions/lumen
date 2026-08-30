import 'server-only'
import { prisma } from '@/server/db/client'
import { OUTCOMES } from './outcomes'
import { closeAbandonedSessions } from './sessions'
import type { CallOutcome, Prisma } from '@prisma/client'

/**
 * Daily reports.
 *
 * A report is a *snapshot*, not a view. Recomputing yesterday's numbers on
 * demand would let them drift as leads are reassigned and stages change; an
 * agent whose Tuesday total quietly changes on Thursday has no reason to trust
 * any of it. So the day is rolled up once, stored, and read back verbatim.
 *
 * The day boundary is the workspace's reporting timezone rather than UTC,
 * because "how many calls did you make today" is a question about the agent's
 * working day. `dayKey`/`dayRange` are the only places that conversion happens.
 */

/** Resolves the local calendar day (YYYY-MM-DD) for an instant in a timezone. */
export function dayKey(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the key format we store.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/**
 * The UTC instants bounding a local calendar day.
 *
 * Each boundary is resolved independently, because on a DST transition day they
 * do not share an offset. In Europe/London on 29 March, local midnight is
 * 00:00 UTC (still GMT) but the *next* local midnight is 23:00 UTC (now BST) —
 * a 23-hour day. Using one offset for both ends would shift the whole window by
 * an hour and file the first hour of calls under the wrong day.
 */
export function dayRange(day: string, timeZone: string): { start: Date; end: Date } {
  const [y, m, d] = day.split('-').map(Number)
  return {
    start: localMidnight(y!, m! - 1, d!, timeZone),
    // Day + 1 rather than a separate date string: Date.UTC normalises the
    // month and year rollover, so 31 December works without special-casing.
    end: localMidnight(y!, m! - 1, d! + 1, timeZone),
  }
}

/**
 * The UTC instant of local midnight on a given date.
 *
 * Two passes: guess that the local wall time equals UTC, read the offset that
 * would actually be in force at that instant, then re-read the offset at the
 * corrected instant. The second pass is what handles the case where the first
 * guess lands on the far side of a transition.
 */
function localMidnight(year: number, monthIndex: number, day: number, timeZone: string): Date {
  const wallClock = Date.UTC(year, monthIndex, day, 0, 0, 0)
  const firstPass = wallClock - timeZoneOffsetMs(new Date(wallClock), timeZone)
  const offset = timeZoneOffsetMs(new Date(firstPass), timeZone)
  return new Date(wallClock - offset)
}

function timeZoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - at.getTime()
}

export interface DailyTotals {
  calls: number
  reached: number
  leadsWorked: number
  followUpsSet: number
  callbacks: number
  interested: number
  notInterested: number
  meetingsBooked: number
  sales: number
  doNotCall: number
  activeMinutes: number
  shiftMinutes: number
  firstActivityAt: Date | null
  lastActivityAt: Date | null
  outcomes: Record<string, number>
}

const EMPTY_OUTCOMES = (): Record<string, number> =>
  Object.fromEntries(OUTCOMES.map((o) => [o.value, 0]))

/** Computes one agent's totals for a day. Pure read — writes nothing. */
export async function computeDailyTotals(params: {
  workspaceId: string
  userId: string
  start: Date
  end: Date
}): Promise<DailyTotals> {
  const { workspaceId, userId, start, end } = params
  const window = { gte: start, lt: end }

  const [byOutcome, distinctLeads, bounds, followUps, sessions] = await Promise.all([
    prisma.callLog.groupBy({
      by: ['outcome', 'contactReached'],
      where: { workspaceId, userId, createdAt: window },
      _count: { _all: true },
    }),
    prisma.callLog.findMany({
      where: { workspaceId, userId, createdAt: window },
      select: { businessId: true },
      distinct: ['businessId'],
    }),
    prisma.callLog.aggregate({
      where: { workspaceId, userId, createdAt: window },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.callLog.count({
      where: { workspaceId, userId, createdAt: window, followUpAt: { not: null } },
    }),
    // A shift that starts inside the day counts toward it, including one that
    // runs past midnight — the report belongs to the day the agent clocked in.
    prisma.workSession.findMany({
      where: { workspaceId, userId, startedAt: window },
      select: { startedAt: true, endedAt: true, activeSeconds: true },
    }),
  ])

  const outcomes = EMPTY_OUTCOMES()
  let calls = 0
  let reached = 0
  for (const row of byOutcome) {
    outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + row._count._all
    calls += row._count._all
    if (row.contactReached) reached += row._count._all
  }

  const shiftSeconds = sessions.reduce((sum, s) => {
    const endedAt = s.endedAt ?? new Date()
    return sum + Math.max(0, Math.round((endedAt.getTime() - s.startedAt.getTime()) / 1000))
  }, 0)
  const activeSeconds = sessions.reduce((sum, s) => sum + s.activeSeconds, 0)

  const count = (o: CallOutcome) => outcomes[o] ?? 0

  return {
    calls,
    reached,
    leadsWorked: distinctLeads.length,
    followUpsSet: followUps,
    callbacks: count('CALLBACK_REQUESTED'),
    interested: count('INTERESTED'),
    notInterested: count('NOT_INTERESTED'),
    meetingsBooked: count('MEETING_BOOKED'),
    sales: count('SALE'),
    doNotCall: count('DO_NOT_CALL'),
    activeMinutes: Math.round(activeSeconds / 60),
    shiftMinutes: Math.round(shiftSeconds / 60),
    firstActivityAt: bounds._min.createdAt,
    lastActivityAt: bounds._max.createdAt,
    outcomes,
  }
}

/**
 * Writes (or rewrites) one agent's report for one day.
 *
 * Upsert rather than insert so a re-run corrects a day that was rolled up while
 * an agent was still working — the end-of-day job can run more than once
 * without producing duplicates or stale halves.
 */
export async function generateDailyReport(params: {
  workspaceId: string
  userId: string
  day: string
  timeZone: string
}): Promise<{ day: string; userId: string; totals: DailyTotals }> {
  const { start, end } = dayRange(params.day, params.timeZone)
  const totals = await computeDailyTotals({
    workspaceId: params.workspaceId,
    userId: params.userId,
    start,
    end,
  })

  const data = {
    calls: totals.calls,
    reached: totals.reached,
    leadsWorked: totals.leadsWorked,
    followUpsSet: totals.followUpsSet,
    callbacks: totals.callbacks,
    interested: totals.interested,
    notInterested: totals.notInterested,
    meetingsBooked: totals.meetingsBooked,
    sales: totals.sales,
    doNotCall: totals.doNotCall,
    activeMinutes: totals.activeMinutes,
    shiftMinutes: totals.shiftMinutes,
    firstActivityAt: totals.firstActivityAt,
    lastActivityAt: totals.lastActivityAt,
    outcomes: totals.outcomes as Prisma.InputJsonValue,
    generatedAt: new Date(),
  }

  await prisma.dailyReport.upsert({
    where: { userId_day: { userId: params.userId, day: params.day } },
    create: { workspaceId: params.workspaceId, userId: params.userId, day: params.day, ...data },
    update: data,
  })

  return { day: params.day, userId: params.userId, totals }
}

/**
 * End-of-day roll-up for a whole workspace.
 *
 * Closes forgotten shifts first, so the shift minutes in the report reflect
 * work rather than a window someone left open.
 */
export async function generateWorkspaceReports(params: {
  workspaceId: string
  day: string
  timeZone: string
  /** Skip agents with no calls and no shift — an empty row helps nobody. */
  skipEmpty?: boolean
}): Promise<{ day: string; generated: number; skipped: number; closedSessions: number }> {
  const closedSessions = await closeAbandonedSessions({
    workspaceId: params.workspaceId,
    olderThanHours: 16,
  })

  const members = await prisma.membership.findMany({
    where: { workspaceId: params.workspaceId, role: { in: ['AGENT', 'MEMBER', 'ADMIN', 'OWNER'] } },
    select: { userId: true },
  })

  let generated = 0
  let skipped = 0

  for (const m of members) {
    const { totals } = await generateDailyReportIfWorked({
      workspaceId: params.workspaceId,
      userId: m.userId,
      day: params.day,
      timeZone: params.timeZone,
      skipEmpty: params.skipEmpty ?? true,
    })
    if (totals) generated++
    else skipped++
  }

  return { day: params.day, generated, skipped, closedSessions }
}

async function generateDailyReportIfWorked(params: {
  workspaceId: string
  userId: string
  day: string
  timeZone: string
  skipEmpty: boolean
}): Promise<{ totals: DailyTotals | null }> {
  const { start, end } = dayRange(params.day, params.timeZone)
  const totals = await computeDailyTotals({
    workspaceId: params.workspaceId,
    userId: params.userId,
    start,
    end,
  })

  if (params.skipEmpty && totals.calls === 0 && totals.shiftMinutes === 0) {
    return { totals: null }
  }

  await generateDailyReport({
    workspaceId: params.workspaceId,
    userId: params.userId,
    day: params.day,
    timeZone: params.timeZone,
  })
  return { totals }
}

export interface ReportRow {
  userId: string
  name: string
  email: string
  avatarPath: string | null
  day: string
  calls: number
  reached: number
  leadsWorked: number
  followUpsSet: number
  meetingsBooked: number
  sales: number
  interested: number
  notInterested: number
  doNotCall: number
  activeMinutes: number
  shiftMinutes: number
  firstActivityAt: Date | null
  lastActivityAt: Date | null
  outcomes: Record<string, number>
  /** Reached ÷ calls, as a percentage. Null when no calls were made. */
  contactRate: number | null
  /** Calls per active hour. Null when no active time was recorded. */
  callsPerHour: number | null
}

export async function reportsForRange(params: {
  workspaceId: string
  from: string
  to: string
  userId?: string
}): Promise<ReportRow[]> {
  const reports = await prisma.dailyReport.findMany({
    where: {
      workspaceId: params.workspaceId,
      day: { gte: params.from, lte: params.to },
      ...(params.userId ? { userId: params.userId } : {}),
    },
    include: {
      user: { select: { id: true, name: true, email: true, avatarPath: true } },
    },
    orderBy: [{ day: 'desc' }, { calls: 'desc' }],
  })

  return reports.map((r) => ({
    userId: r.userId,
    name: r.user.name ?? r.user.email,
    email: r.user.email,
    avatarPath: r.user.avatarPath,
    day: r.day,
    calls: r.calls,
    reached: r.reached,
    leadsWorked: r.leadsWorked,
    followUpsSet: r.followUpsSet,
    meetingsBooked: r.meetingsBooked,
    sales: r.sales,
    interested: r.interested,
    notInterested: r.notInterested,
    doNotCall: r.doNotCall,
    activeMinutes: r.activeMinutes,
    shiftMinutes: r.shiftMinutes,
    firstActivityAt: r.firstActivityAt,
    lastActivityAt: r.lastActivityAt,
    outcomes: (r.outcomes as Record<string, number>) ?? {},
    contactRate: r.calls > 0 ? Math.round((r.reached / r.calls) * 100) : null,
    callsPerHour:
      r.activeMinutes > 0 ? Math.round((r.calls / (r.activeMinutes / 60)) * 10) / 10 : null,
  }))
}

/** Adds up a set of daily rows — used for the range summary at the top. */
export function summarise(rows: ReportRow[]) {
  const total = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      reached: acc.reached + r.reached,
      leadsWorked: acc.leadsWorked + r.leadsWorked,
      meetingsBooked: acc.meetingsBooked + r.meetingsBooked,
      sales: acc.sales + r.sales,
      interested: acc.interested + r.interested,
      activeMinutes: acc.activeMinutes + r.activeMinutes,
      shiftMinutes: acc.shiftMinutes + r.shiftMinutes,
    }),
    {
      calls: 0, reached: 0, leadsWorked: 0, meetingsBooked: 0,
      sales: 0, interested: 0, activeMinutes: 0, shiftMinutes: 0,
    },
  )

  return {
    ...total,
    agents: new Set(rows.map((r) => r.userId)).size,
    days: new Set(rows.map((r) => r.day)).size,
    contactRate: total.calls > 0 ? Math.round((total.reached / total.calls) * 100) : null,
    callsPerHour:
      total.activeMinutes > 0
        ? Math.round((total.calls / (total.activeMinutes / 60)) * 10) / 10
        : null,
  }
}
