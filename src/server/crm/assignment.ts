import 'server-only'
import { prisma } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { TERMINAL_OUTCOMES } from './outcomes'
import type { Prisma } from '@prisma/client'

/**
 * Lead ownership.
 *
 * `Business.assignedToId` is the denormalised current owner — an agent's queue
 * has to be a single indexed read, not a join through assignment history. The
 * `LeadAssignment` rows are the history: who gave the lead to whom, when, by
 * what method, and when it was taken back. Both are written together so the
 * denormalised column can never disagree with the record that explains it.
 *
 * Two rules are enforced here rather than in the UI, because the UI is not the
 * only caller:
 *
 * - A lead marked DO_NOT_CALL is never assigned to anyone, by any method. The
 *   business asked not to be contacted; routing it back into a calling queue
 *   would be the one mistake this system must not make.
 * - An assignee must be an active member of the same workspace. A stale user id
 *   from another workspace would otherwise expose leads across the §29 boundary.
 */

export type AssignMethod = 'manual' | 'round-robin' | 'rule' | 'reclaim'

export interface Assignable {
  id: string
  name: string
}

/** Members who can be given leads to call. */
export async function assignableAgents(workspaceId: string): Promise<
  Array<{ id: string; name: string; email: string; role: string; openLeads: number }>
> {
  const members = await prisma.membership.findMany({
    where: { workspaceId, role: { in: ['AGENT', 'MEMBER', 'ADMIN'] }, user: { isActive: true } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const counts = await prisma.business.groupBy({
    by: ['assignedToId'],
    where: { workspaceId, assignedToId: { not: null } },
    _count: { _all: true },
  })
  const byUser = new Map(counts.map((c) => [c.assignedToId, c._count._all]))

  return members.map((m) => ({
    id: m.user.id,
    name: m.user.name ?? m.user.email,
    email: m.user.email,
    role: m.role,
    openLeads: byUser.get(m.user.id) ?? 0,
  }))
}

async function assertAssignable(workspaceId: string, userId: string): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    include: { user: { select: { isActive: true } } },
  })
  if (!membership) throw new HttpError(400, 'That user is not a member of this workspace')
  if (!membership.user.isActive) throw new HttpError(400, 'That account is disabled')
  if (membership.role === 'VIEWER') {
    throw new HttpError(400, 'Viewers cannot be assigned leads to call')
  }
}

export interface AssignResult {
  assigned: number
  skipped: number
  /** Why rows were skipped, for an honest message rather than a silent count. */
  reasons: string[]
}

/**
 * Assigns specific leads to one agent.
 *
 * Ids not in the workspace are silently excluded by the where clause rather
 * than trusted — the caller may be passing a selection from a stale page.
 */
export async function assignLeads(params: {
  workspaceId: string
  businessIds: string[]
  assignedToId: string
  assignedById: string
  method?: AssignMethod
  reason?: string
}): Promise<AssignResult> {
  const { workspaceId, businessIds, assignedToId, assignedById } = params
  if (businessIds.length === 0) return { assigned: 0, skipped: 0, reasons: [] }

  await assertAssignable(workspaceId, assignedToId)

  const eligible = await prisma.business.findMany({
    where: { id: { in: businessIds }, workspaceId },
    select: { id: true, lastCallOutcome: true, outreach: { select: { stage: true } } },
  })

  const reasons: string[] = []
  const blocked = eligible.filter(
    (b) => b.lastCallOutcome === 'DO_NOT_CALL' || b.outreach?.stage === 'DO_NOT_CONTACT',
  )
  const ok = eligible.filter((b) => !blocked.some((x) => x.id === b.id))

  const notFound = businessIds.length - eligible.length
  if (notFound > 0) reasons.push(`${notFound} lead(s) are not in this workspace`)
  if (blocked.length > 0) {
    reasons.push(`${blocked.length} lead(s) are marked do-not-call and were left unassigned`)
  }
  if (ok.length === 0) return { assigned: 0, skipped: businessIds.length, reasons }

  const ids = ok.map((b) => b.id)
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    // Close the open assignment rows for these leads before opening new ones,
    // so history never shows a lead owned by two people at once.
    await tx.leadAssignment.updateMany({
      where: { businessId: { in: ids }, releasedAt: null },
      data: { releasedAt: now },
    })
    await tx.business.updateMany({
      where: { id: { in: ids } },
      data: { assignedToId, assignedAt: now },
    })
    await tx.leadAssignment.createMany({
      data: ids.map((businessId) => ({
        workspaceId,
        businessId,
        assignedToId,
        assignedById,
        method: params.method ?? 'manual',
        assignedAt: now,
        reason: params.reason ?? null,
      })),
    })
  })

  return { assigned: ids.length, skipped: businessIds.length - ids.length, reasons }
}

/** Returns leads to the unassigned pool. */
export async function unassignLeads(params: {
  workspaceId: string
  businessIds: string[]
  reason?: string
}): Promise<number> {
  const { workspaceId, businessIds } = params
  if (businessIds.length === 0) return 0
  const now = new Date()

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.business.updateMany({
      where: { id: { in: businessIds }, workspaceId, assignedToId: { not: null } },
      data: { assignedToId: null, assignedAt: null },
    })
    await tx.leadAssignment.updateMany({
      where: { businessId: { in: businessIds }, workspaceId, releasedAt: null },
      data: { releasedAt: now, reason: params.reason ?? null },
    })
    return count
  })
}

/**
 * Where clause for leads that may enter a calling queue.
 *
 * Callable means: has a phone number, is not demo data, has not reached a
 * terminal outcome, and is not marked do-not-contact. Everything that
 * auto-assigns shares this definition so the rules cannot drift apart.
 */
export function callableWhere(workspaceId: string): Prisma.BusinessWhereInput {
  return {
    workspaceId,
    isDemo: false,
    primaryPhone: { not: null },
    OR: [{ lastCallOutcome: null }, { lastCallOutcome: { notIn: TERMINAL_OUTCOMES } }],
    NOT: { outreach: { stage: { in: ['DO_NOT_CONTACT', 'WON', 'LOST'] } } },
  }
}

export interface RoundRobinResult extends AssignResult {
  perAgent: Array<{ userId: string; name: string; count: number }>
}

/**
 * Distributes unassigned callable leads evenly across the chosen agents.
 *
 * Highest lead score first: if there are not enough leads to fill everyone's
 * quota, the ones that get worked should be the ones most worth working.
 * Existing workload is taken into account, so an agent already holding 200
 * leads is not handed the same share as one holding none.
 */
export async function roundRobinAssign(params: {
  workspaceId: string
  assignedById: string
  agentIds: string[]
  /** Maximum open leads any one agent should end up holding. */
  targetPerAgent: number
  /** Optional cap on how many leads to hand out in this run. */
  limit?: number
}): Promise<RoundRobinResult> {
  const { workspaceId, agentIds, assignedById, targetPerAgent } = params
  if (agentIds.length === 0) {
    return { assigned: 0, skipped: 0, reasons: ['No agents selected'], perAgent: [] }
  }

  for (const id of agentIds) await assertAssignable(workspaceId, id)

  const agents = await prisma.user.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true, email: true },
  })

  const current = await prisma.business.groupBy({
    by: ['assignedToId'],
    where: { workspaceId, assignedToId: { in: agentIds } },
    _count: { _all: true },
  })
  const held = new Map(current.map((c) => [c.assignedToId as string, c._count._all]))

  // How many each agent still has room for.
  const capacity = agents.map((a) => ({
    userId: a.id,
    name: a.name ?? a.email,
    room: Math.max(0, targetPerAgent - (held.get(a.id) ?? 0)),
  }))

  const totalRoom = capacity.reduce((sum, c) => sum + c.room, 0)
  const take = Math.min(totalRoom, params.limit ?? totalRoom)
  if (take === 0) {
    return {
      assigned: 0,
      skipped: 0,
      reasons: ['Every selected agent is already at the target lead count'],
      perAgent: capacity.map((c) => ({ userId: c.userId, name: c.name, count: 0 })),
    }
  }

  const pool = await prisma.business.findMany({
    where: { ...callableWhere(workspaceId), assignedToId: null },
    select: { id: true },
    orderBy: [{ leadScore: 'desc' }, { createdAt: 'asc' }],
    take,
  })

  if (pool.length === 0) {
    return {
      assigned: 0,
      skipped: 0,
      reasons: ['No unassigned leads with a phone number are available'],
      perAgent: capacity.map((c) => ({ userId: c.userId, name: c.name, count: 0 })),
    }
  }

  // Deal one at a time to whoever has the most room left, so an agent starting
  // from zero catches up instead of everyone receiving an identical slice.
  const buckets = new Map<string, string[]>(capacity.map((c) => [c.userId, []]))
  const room = new Map(capacity.map((c) => [c.userId, c.room]))

  for (const lead of pool) {
    let best: string | null = null
    for (const [userId, left] of room) {
      if (left <= 0) continue
      if (best === null || left > (room.get(best) ?? 0)) best = userId
    }
    if (!best) break
    buckets.get(best)!.push(lead.id)
    room.set(best, (room.get(best) ?? 0) - 1)
  }

  const perAgent: RoundRobinResult['perAgent'] = []
  let assigned = 0

  for (const cap of capacity) {
    const ids = buckets.get(cap.userId) ?? []
    if (ids.length > 0) {
      const res = await assignLeads({
        workspaceId,
        businessIds: ids,
        assignedToId: cap.userId,
        assignedById,
        method: 'round-robin',
      })
      assigned += res.assigned
      perAgent.push({ userId: cap.userId, name: cap.name, count: res.assigned })
    } else {
      perAgent.push({ userId: cap.userId, name: cap.name, count: 0 })
    }
  }

  return { assigned, skipped: 0, reasons: [], perAgent }
}

/**
 * Returns leads that have sat with an agent untouched to the pool.
 *
 * A lead nobody has called in `staleDays` is not being worked; leaving it
 * assigned makes an agent's queue look full while the lead goes cold. Leads
 * with a scheduled follow-up in the future are never reclaimed — those are
 * being worked, just not today.
 */
export async function reclaimStaleLeads(params: {
  workspaceId: string
  staleDays: number
  dryRun?: boolean
}): Promise<{ count: number; sample: Array<{ id: string; name: string; agent: string }> }> {
  const cutoff = new Date(Date.now() - params.staleDays * 24 * 60 * 60 * 1000)

  const stale = await prisma.business.findMany({
    where: {
      workspaceId: params.workspaceId,
      assignedToId: { not: null },
      assignedAt: { lt: cutoff },
      AND: [
        { OR: [{ lastCallAt: null }, { lastCallAt: { lt: cutoff } }] },
        { OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lt: new Date() } }] },
      ],
    },
    select: { id: true, name: true, assignedTo: { select: { name: true, email: true } } },
    take: 500,
  })

  if (stale.length === 0 || params.dryRun) {
    return {
      count: stale.length,
      sample: stale.slice(0, 10).map((b) => ({
        id: b.id,
        name: b.name,
        agent: b.assignedTo?.name ?? b.assignedTo?.email ?? 'unknown',
      })),
    }
  }

  await unassignLeads({
    workspaceId: params.workspaceId,
    businessIds: stale.map((b) => b.id),
    reason: `Reclaimed — untouched for ${params.staleDays} days`,
  })

  return {
    count: stale.length,
    sample: stale.slice(0, 10).map((b) => ({
      id: b.id,
      name: b.name,
      agent: b.assignedTo?.name ?? b.assignedTo?.email ?? 'unknown',
    })),
  }
}
