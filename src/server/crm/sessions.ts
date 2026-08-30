import 'server-only'
import { prisma } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'

/**
 * Shift tracking and presence.
 *
 * Two different clocks, kept apart on purpose:
 *
 * - **Shift time** (`WorkSession.startedAt → endedAt`) is wall-clock: the span
 *   between clocking in and clocking out.
 * - **Active time** (`activeSeconds`) only accrues while the client is sending
 *   heartbeats. Leaving the app open overnight adds shift time but no active
 *   time, so the two numbers together say something a single number could not:
 *   how long someone was on shift versus how long they were actually working.
 *
 * Active time is accumulated server-side from heartbeat gaps rather than
 * accepted from the client, because a client-reported duration is a number the
 * agent's own machine could choose.
 */

/** A heartbeat further apart than this is treated as a break, not work. */
const MAX_HEARTBEAT_GAP_SECONDS = 150

/** Presence goes stale after this, so a crashed client stops reading "online". */
export const PRESENCE_ONLINE_SECONDS = 90
export const PRESENCE_IDLE_SECONDS = 300

export interface ActiveSession {
  id: string
  startedAt: Date
  activeSeconds: number
  shiftSeconds: number
}

export async function currentSession(
  workspaceId: string,
  userId: string,
): Promise<ActiveSession | null> {
  const session = await prisma.workSession.findFirst({
    where: { workspaceId, userId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  })
  if (!session) return null
  return {
    id: session.id,
    startedAt: session.startedAt,
    activeSeconds: session.activeSeconds,
    shiftSeconds: Math.round((Date.now() - session.startedAt.getTime()) / 1000),
  }
}

/**
 * Clocks in. Idempotent: an agent who reloads the app resumes the session they
 * already have rather than opening a second one, which would double-count the
 * shift.
 */
export async function clockIn(workspaceId: string, userId: string): Promise<ActiveSession> {
  const existing = await currentSession(workspaceId, userId)
  if (existing) return existing

  const session = await prisma.workSession.create({
    data: { workspaceId, userId },
  })

  await touchPresence({ workspaceId, userId, sessionId: session.id, status: 'online' })

  return {
    id: session.id,
    startedAt: session.startedAt,
    activeSeconds: 0,
    shiftSeconds: 0,
  }
}

export async function clockOut(
  workspaceId: string,
  userId: string,
  endedBy: 'manual' | 'auto' = 'manual',
): Promise<{ shiftSeconds: number; activeSeconds: number } | null> {
  const session = await prisma.workSession.findFirst({
    where: { workspaceId, userId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  })
  if (!session) return null

  const endedAt = new Date()
  await prisma.$transaction([
    prisma.workSession.update({
      where: { id: session.id },
      data: { endedAt, endedBy },
    }),
    prisma.agentPresence.updateMany({
      where: { userId },
      data: { status: 'offline', currentBusinessId: null, currentSessionId: null },
    }),
  ])

  const shiftSeconds = Math.max(
    0,
    Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000),
  )
  return {
    shiftSeconds,
    // Clamped for the same reason the credit is: a shift cannot contain more
    // work than it lasted, whatever the stored counter says.
    activeSeconds: Math.min(session.activeSeconds, shiftSeconds),
  }
}

/**
 * Records that the agent is alive and, optionally, which lead they are on.
 *
 * Accrues active time from the gap since the last heartbeat, capped so that a
 * closed laptop reopened an hour later does not book an hour of work.
 */
export async function touchPresence(params: {
  workspaceId: string
  userId: string
  sessionId?: string | null
  currentBusinessId?: string | null
  status?: 'online' | 'idle'
}): Promise<{ activeSeconds: number | null }> {
  const now = new Date()

  const existing = await prisma.agentPresence.findUnique({
    where: { userId: params.userId },
    select: { lastSeenAt: true, currentSessionId: true },
  })

  const gapSeconds = existing
    ? Math.round((now.getTime() - existing.lastSeenAt.getTime()) / 1000)
    : 0

  const sessionId = params.sessionId ?? existing?.currentSessionId ?? null

  let activeSeconds: number | null = null
  if (sessionId && gapSeconds > 0 && gapSeconds <= MAX_HEARTBEAT_GAP_SECONDS) {
    const session = await prisma.workSession.findFirst({
      where: { id: sessionId, endedAt: null },
      select: { startedAt: true, activeSeconds: true },
    })
    if (session) {
      // Active time can never exceed the shift it accrued in. Without this an
      // adjusted clock, or a heartbeat arriving just after clock-in, could book
      // more work than the shift has lasted — and calls-per-hour, which divides
      // by this number, would report a rate nobody achieved.
      const shiftSeconds = Math.max(
        0,
        Math.round((now.getTime() - session.startedAt.getTime()) / 1000),
      )
      const credit = Math.min(gapSeconds, Math.max(0, shiftSeconds - session.activeSeconds))
      if (credit > 0) {
        const updated = await prisma.workSession.update({
          where: { id: sessionId },
          data: { activeSeconds: { increment: credit } },
          select: { activeSeconds: true },
        })
        activeSeconds = updated.activeSeconds
      } else {
        activeSeconds = session.activeSeconds
      }
    }
  }

  await prisma.agentPresence.upsert({
    where: { userId: params.userId },
    create: {
      workspaceId: params.workspaceId,
      userId: params.userId,
      status: params.status ?? 'online',
      lastSeenAt: now,
      currentBusinessId: params.currentBusinessId ?? null,
      currentSessionId: sessionId,
    },
    update: {
      status: params.status ?? 'online',
      lastSeenAt: now,
      // `undefined` leaves the current lead alone; `null` explicitly clears it.
      currentBusinessId:
        params.currentBusinessId === undefined ? undefined : params.currentBusinessId,
      currentSessionId: sessionId,
    },
  })

  return { activeSeconds }
}

export type PresenceStatus = 'online' | 'idle' | 'offline'

/**
 * Derives status from `lastSeenAt` rather than trusting the stored string.
 * A process killed mid-shift never writes "offline", so a stored status alone
 * would leave that agent showing as online indefinitely.
 */
export function derivePresence(lastSeenAt: Date, stored: string): PresenceStatus {
  if (stored === 'offline') return 'offline'
  const age = (Date.now() - lastSeenAt.getTime()) / 1000
  if (age <= PRESENCE_ONLINE_SECONDS) return 'online'
  if (age <= PRESENCE_IDLE_SECONDS) return 'idle'
  return 'offline'
}

export interface LiveAgent {
  userId: string
  name: string
  email: string
  avatarPath: string | null
  status: PresenceStatus
  /** Null when this person has never opened the agent app. */
  lastSeenAt: Date | null
  onLead: { id: string; name: string } | null
  clockedInAt: Date | null
  shiftSeconds: number
  activeSeconds: number
  callsToday: number
  reachedToday: number
  lastCallAt: Date | null
}

/**
 * The live supervisor view: who is on shift, what they are on, and what they
 * have done today. One query per fact rather than per agent, so the page cost
 * does not grow with headcount.
 */
export async function liveAgents(workspaceId: string, dayStart: Date): Promise<LiveAgent[]> {
  const members = await prisma.membership.findMany({
    where: { workspaceId, role: { in: ['AGENT', 'MEMBER', 'ADMIN', 'OWNER'] } },
    include: {
      user: {
        select: { id: true, name: true, email: true, avatarPath: true, isActive: true },
      },
    },
  })
  const active = members.filter((m) => m.user.isActive)
  const userIds = active.map((m) => m.user.id)
  if (userIds.length === 0) return []

  const [presence, sessions, callStats, lastCalls] = await Promise.all([
    prisma.agentPresence.findMany({
      where: { userId: { in: userIds } },
      include: { },
    }),
    prisma.workSession.findMany({
      where: { workspaceId, userId: { in: userIds }, endedAt: null },
      orderBy: { startedAt: 'desc' },
    }),
    prisma.callLog.groupBy({
      by: ['userId', 'contactReached'],
      where: { workspaceId, userId: { in: userIds }, createdAt: { gte: dayStart } },
      _count: { _all: true },
    }),
    prisma.callLog.groupBy({
      by: ['userId'],
      where: { workspaceId, userId: { in: userIds } },
      _max: { createdAt: true },
    }),
  ])

  const onLeadIds = presence.map((p) => p.currentBusinessId).filter((id): id is string => !!id)
  const leads = onLeadIds.length
    ? await prisma.business.findMany({
        where: { id: { in: onLeadIds }, workspaceId },
        select: { id: true, name: true },
      })
    : []
  const leadById = new Map(leads.map((l) => [l.id, l]))

  const presenceByUser = new Map(presence.map((p) => [p.userId, p]))
  const sessionByUser = new Map<string, (typeof sessions)[number]>()
  for (const s of sessions) if (!sessionByUser.has(s.userId)) sessionByUser.set(s.userId, s)
  const lastCallByUser = new Map(lastCalls.map((c) => [c.userId, c._max.createdAt]))

  const callsByUser = new Map<string, { calls: number; reached: number }>()
  for (const row of callStats) {
    const entry = callsByUser.get(row.userId) ?? { calls: 0, reached: 0 }
    entry.calls += row._count._all
    if (row.contactReached) entry.reached += row._count._all
    callsByUser.set(row.userId, entry)
  }

  const now = Date.now()

  return active
    .map((m) => {
      const p = presenceByUser.get(m.user.id)
      const s = sessionByUser.get(m.user.id)
      const stats = callsByUser.get(m.user.id) ?? { calls: 0, reached: 0 }
      const lead = p?.currentBusinessId ? leadById.get(p.currentBusinessId) : null

      return {
        userId: m.user.id,
        name: m.user.name ?? m.user.email,
        email: m.user.email,
        avatarPath: m.user.avatarPath,
        status: p ? derivePresence(p.lastSeenAt, p.status) : ('offline' as PresenceStatus),
        lastSeenAt: p?.lastSeenAt ?? null,
        onLead: lead ? { id: lead.id, name: lead.name } : null,
        clockedInAt: s?.startedAt ?? null,
        shiftSeconds: s ? Math.round((now - s.startedAt.getTime()) / 1000) : 0,
        activeSeconds: s?.activeSeconds ?? 0,
        callsToday: stats.calls,
        reachedToday: stats.reached,
        lastCallAt: lastCallByUser.get(m.user.id) ?? null,
      }
    })
    .sort((a, b) => {
      const rank = { online: 0, idle: 1, offline: 2 }
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
      return b.callsToday - a.callsToday
    })
}

/**
 * Closes shifts left open past the end of the day.
 *
 * Agents forget to clock out. Without this, one forgotten session turns into a
 * 40-hour shift in the next day's report and the number becomes worthless.
 */
export async function closeAbandonedSessions(params: {
  workspaceId: string
  olderThanHours: number
}): Promise<number> {
  const cutoff = new Date(Date.now() - params.olderThanHours * 60 * 60 * 1000)
  const open = await prisma.workSession.findMany({
    where: { workspaceId: params.workspaceId, endedAt: null, startedAt: { lt: cutoff } },
    select: { id: true, userId: true, startedAt: true, activeSeconds: true },
  })
  if (open.length === 0) return 0

  await prisma.$transaction([
    ...open.map((s) =>
      prisma.workSession.update({
        where: { id: s.id },
        data: {
          // End the shift at the last credited activity, not at "now" — an
          // agent who worked two hours then walked away worked two hours.
          endedAt: new Date(s.startedAt.getTime() + s.activeSeconds * 1000),
          endedBy: 'auto',
        },
      }),
    ),
    prisma.agentPresence.updateMany({
      where: { userId: { in: open.map((s) => s.userId) } },
      data: { status: 'offline', currentBusinessId: null, currentSessionId: null },
    }),
  ])

  return open.length
}

export async function assertClockedIn(
  workspaceId: string,
  userId: string,
): Promise<ActiveSession> {
  const session = await currentSession(workspaceId, userId)
  if (!session) throw new HttpError(409, 'Clock in before logging work')
  return session
}
