import 'server-only'
import { prisma } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { outcomeMeta } from './outcomes'
import { touchPresence } from './sessions'
import type { CallOutcome } from '@prisma/client'

/**
 * Call logging — the strict work record.
 *
 * Every call an agent makes produces exactly one row here, and the row cannot
 * be edited or deleted afterwards. That is deliberate: the daily report and the
 * supervisor view are only worth reading if the underlying record is immutable.
 * Agents correct a mistake by logging a follow-up call with a note, the way a
 * ledger is corrected by a new entry rather than by an erasure.
 *
 * Writing a call also updates four things in one transaction:
 *
 *   1. The `CallLog` row itself.
 *   2. The rollup columns on `Business` (`callCount`, `lastCallAt`,
 *      `lastCallOutcome`, `nextFollowUpAt`) so the leads table can sort and
 *      filter on call activity without an aggregate.
 *   3. The outreach stage, when the outcome implies one.
 *   4. The agent's presence, so the supervisor view shows what they are on.
 *
 * If any of those failed independently the record would be internally
 * inconsistent, which is why they share a transaction.
 */

export interface LogCallInput {
  workspaceId: string
  userId: string
  businessId: string
  outcome: CallOutcome
  phoneUsed?: string | null
  notes?: string | null
  /** When the agent opened the lead — gives a real handling time. */
  startedAt?: Date | null
  followUpAt?: Date | null
  /** Set when the agent is clocked in; ties the call to a shift. */
  sessionId?: string | null
}

export interface LoggedCall {
  id: string
  outcome: CallOutcome
  followUpAt: Date | null
  /** True when this outcome removed the lead from the calling queue. */
  closed: boolean
  callCount: number
}

export async function logCall(input: LogCallInput): Promise<LoggedCall> {
  const meta = outcomeMeta(input.outcome)

  const business = await prisma.business.findFirst({
    where: { id: input.businessId, workspaceId: input.workspaceId },
    select: {
      id: true,
      assignedToId: true,
      callCount: true,
      primaryPhone: true,
      outreach: { select: { id: true, stage: true } },
    },
  })
  if (!business) throw new HttpError(404, 'Lead not found in this workspace')

  // §29 — an agent may only log work against a lead they actually hold.
  //
  // The check runs whenever the lead is not theirs, which includes a lead
  // assigned to nobody: otherwise an agent could call straight down the
  // workspace's list through the API, outside any queue a supervisor set, and
  // their day's numbers would describe work nobody asked for. Supervisors and
  // members are trusted here — they are the ones who decide what gets called.
  if (business.assignedToId !== input.userId) {
    const membership = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
      select: { role: true },
    })
    if (!membership || membership.role === 'AGENT' || membership.role === 'VIEWER') {
      throw new HttpError(
        403,
        business.assignedToId
          ? 'This lead is assigned to someone else'
          : 'This lead is not in your queue',
      )
    }
  }

  // Follow-up rules are the difference between a record and a complete record.
  if (meta.followUp === 'required' && !input.followUpAt) {
    throw new HttpError(400, `"${meta.label}" requires a follow-up date before it can be saved`)
  }
  if (meta.followUp === 'forbidden' && input.followUpAt) {
    throw new HttpError(400, `"${meta.label}" cannot have a follow-up — the lead is closed`)
  }
  if (input.followUpAt && input.followUpAt.getTime() < Date.now() - 60_000) {
    throw new HttpError(400, 'The follow-up time is in the past')
  }

  const endedAt = new Date()
  const startedAt = input.startedAt ?? endedAt
  // Clamp: a stale browser tab must not report a nine-hour call.
  const rawSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
  const durationSec = rawSeconds >= 0 && rawSeconds <= 4 * 60 * 60 ? rawSeconds : null

  const notes = input.notes?.trim() || null
  const phoneUsed = input.phoneUsed?.trim() || business.primaryPhone

  const call = await prisma.$transaction(async (tx) => {
    const created = await tx.callLog.create({
      data: {
        workspaceId: input.workspaceId,
        businessId: business.id,
        userId: input.userId,
        outcome: input.outcome,
        contactReached: meta.reached,
        phoneUsed,
        notes,
        startedAt,
        endedAt,
        durationSec,
        followUpAt: input.followUpAt ?? null,
      },
      select: { id: true },
    })

    await tx.business.update({
      where: { id: business.id },
      data: {
        callCount: { increment: 1 },
        lastCallAt: endedAt,
        lastCallOutcome: input.outcome,
        nextFollowUpAt: input.followUpAt ?? null,
        // A closed lead leaves the agent's queue. The assignment history keeps
        // who worked it, so nothing is lost by clearing the current owner.
        ...(meta.terminal ? { assignedToId: null, assignedAt: null } : {}),
      },
    })

    if (meta.terminal) {
      await tx.leadAssignment.updateMany({
        where: { businessId: business.id, releasedAt: null },
        data: { releasedAt: endedAt, reason: `Closed: ${meta.label}` },
      })
    }

    if (meta.stage) {
      await tx.outreachStatus.upsert({
        where: { businessId: business.id },
        create: {
          businessId: business.id,
          stage: meta.stage,
          assignedUserId: input.userId,
          lastContactAt: meta.reached ? endedAt : null,
          nextFollowUpAt: input.followUpAt ?? null,
        },
        update: {
          stage: meta.stage,
          ...(meta.reached ? { lastContactAt: endedAt } : {}),
          nextFollowUpAt: input.followUpAt ?? null,
        },
      })
    } else if (meta.reached || business.outreach) {
      await tx.outreachStatus.upsert({
        where: { businessId: business.id },
        create: {
          businessId: business.id,
          assignedUserId: input.userId,
          lastContactAt: meta.reached ? endedAt : null,
        },
        update: meta.reached ? { lastContactAt: endedAt } : {},
      })
    }

    return created
  })

  await touchPresence({
    workspaceId: input.workspaceId,
    userId: input.userId,
    currentBusinessId: null,
    sessionId: input.sessionId ?? null,
  }).catch(() => {
    // Presence is a convenience for the supervisor view; never fail a saved
    // call because the heartbeat could not be written.
  })

  return {
    id: call.id,
    outcome: input.outcome,
    followUpAt: input.followUpAt ?? null,
    closed: meta.terminal,
    callCount: business.callCount + 1,
  }
}

/** Call history for the lead profile, newest first. */
export async function callHistory(workspaceId: string, businessId: string, take = 50) {
  return prisma.callLog.findMany({
    where: { workspaceId, businessId },
    orderBy: { createdAt: 'desc' },
    take,
    include: { user: { select: { id: true, name: true, email: true, avatarPath: true } } },
  })
}

/**
 * A lead's next action, resolved for display.
 *
 * Returns `overdue` separately from `due` because "you have 4 callbacks you
 * have already missed" is a different message from "you have 4 today".
 */
export async function followUpCounts(workspaceId: string, userId?: string) {
  const now = new Date()
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)

  const base = {
    workspaceId,
    nextFollowUpAt: { not: null },
    ...(userId ? { assignedToId: userId } : {}),
  }

  const [overdue, dueToday, upcoming] = await Promise.all([
    prisma.business.count({ where: { ...base, nextFollowUpAt: { lt: now } } }),
    prisma.business.count({
      where: { ...base, nextFollowUpAt: { gte: now, lte: endOfToday } },
    }),
    prisma.business.count({ where: { ...base, nextFollowUpAt: { gt: endOfToday } } }),
  ])

  return { overdue, dueToday, upcoming }
}
