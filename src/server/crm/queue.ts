import 'server-only'
import { prisma } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { TERMINAL_OUTCOMES } from './outcomes'
import type { Prisma } from '@prisma/client'

/**
 * The agent's calling queue.
 *
 * An agent does not browse leads; they are handed the next one. The ordering
 * below *is* the calling strategy, and it is deliberate:
 *
 *   1. Overdue follow-ups first. A promised callback that has already slipped
 *      is the most damaging thing in the queue.
 *   2. Follow-ups due today, at their due time.
 *   3. Leads never called, best lead score first.
 *   4. Leads called before but with no follow-up set, oldest attempt first, so
 *      nothing is silently abandoned.
 *
 * Everything an agent can see is scoped to `assignedToId = them`. That is the
 * §29 boundary applied a second time inside an already workspace-scoped query:
 * an agent cannot reach another agent's leads even by guessing an id.
 */

export type QueueBucket = 'overdue' | 'today' | 'new' | 'working' | 'upcoming'

export interface QueueItem {
  id: string
  name: string
  primaryPhone: string | null
  city: string | null
  region: string | null
  category: string | null
  websiteUrl: string | null
  leadScore: number | null
  callCount: number
  lastCallAt: Date | null
  lastCallOutcome: string | null
  nextFollowUpAt: Date | null
  bucket: QueueBucket
}

const SELECT = {
  id: true,
  name: true,
  primaryPhone: true,
  city: true,
  region: true,
  category: true,
  websiteUrl: true,
  leadScore: true,
  callCount: true,
  lastCallAt: true,
  lastCallOutcome: true,
  nextFollowUpAt: true,
} satisfies Prisma.BusinessSelect

/** Leads in an agent's queue: assigned to them and still callable. */
export function agentQueueWhere(workspaceId: string, userId: string): Prisma.BusinessWhereInput {
  return {
    workspaceId,
    assignedToId: userId,
    OR: [{ lastCallOutcome: null }, { lastCallOutcome: { notIn: TERMINAL_OUTCOMES } }],
  }
}

export interface QueueCounts {
  overdue: number
  today: number
  new: number
  working: number
  upcoming: number
  total: number
}

export async function queueCounts(workspaceId: string, userId: string): Promise<QueueCounts> {
  const base = agentQueueWhere(workspaceId, userId)
  const now = new Date()
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)

  const [overdue, today, fresh, working, upcoming, total] = await Promise.all([
    prisma.business.count({ where: { ...base, nextFollowUpAt: { lt: now } } }),
    prisma.business.count({
      where: { ...base, nextFollowUpAt: { gte: now, lte: endOfToday } },
    }),
    prisma.business.count({ where: { ...base, callCount: 0 } }),
    prisma.business.count({
      where: { ...base, callCount: { gt: 0 }, nextFollowUpAt: null },
    }),
    prisma.business.count({ where: { ...base, nextFollowUpAt: { gt: endOfToday } } }),
    prisma.business.count({ where: base }),
  ])

  return { overdue, today, new: fresh, working, upcoming, total }
}

function bucketWhere(
  base: Prisma.BusinessWhereInput,
  bucket: QueueBucket | 'all',
): Prisma.BusinessWhereInput {
  const now = new Date()
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)

  switch (bucket) {
    case 'overdue':
      return { ...base, nextFollowUpAt: { lt: now } }
    case 'today':
      return { ...base, nextFollowUpAt: { gte: now, lte: endOfToday } }
    case 'new':
      return { ...base, callCount: 0 }
    case 'working':
      return { ...base, callCount: { gt: 0 }, nextFollowUpAt: null }
    case 'upcoming':
      return { ...base, nextFollowUpAt: { gt: endOfToday } }
    default:
      return base
  }
}

function classify(b: { nextFollowUpAt: Date | null; callCount: number }): QueueBucket {
  const now = Date.now()
  const endOfToday = new Date()
  endOfToday.setHours(23, 59, 59, 999)
  if (b.nextFollowUpAt) {
    if (b.nextFollowUpAt.getTime() < now) return 'overdue'
    if (b.nextFollowUpAt.getTime() <= endOfToday.getTime()) return 'today'
    return 'upcoming'
  }
  return b.callCount === 0 ? 'new' : 'working'
}

export async function agentQueue(params: {
  workspaceId: string
  userId: string
  bucket?: QueueBucket | 'all'
  search?: string
  take?: number
  skip?: number
}): Promise<{ items: QueueItem[]; total: number }> {
  const base = agentQueueWhere(params.workspaceId, params.userId)
  let where = bucketWhere(base, params.bucket ?? 'all')

  const search = params.search?.trim()
  if (search) {
    where = {
      ...where,
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { primaryPhone: { contains: search } },
        { city: { contains: search, mode: 'insensitive' } },
      ],
      // The callable filter lives in `base.OR`, which the spread above would
      // shadow — reapply it as an AND so search cannot surface closed leads.
      AND: [{ OR: base.OR as Prisma.BusinessWhereInput[] }],
    }
  }

  const [rows, total] = await Promise.all([
    prisma.business.findMany({
      where,
      select: SELECT,
      orderBy: [
        // Nulls last on Postgres for ascending order, so leads with a due date
        // sort ahead of leads without one.
        { nextFollowUpAt: { sort: 'asc', nulls: 'last' } },
        { callCount: 'asc' },
        { leadScore: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'asc' },
      ],
      take: params.take ?? 50,
      skip: params.skip ?? 0,
    }),
    prisma.business.count({ where }),
  ])

  return {
    items: rows.map((r) => ({ ...r, bucket: classify(r) })),
    total,
  }
}

/** The single next lead to call. */
export async function nextLead(
  workspaceId: string,
  userId: string,
): Promise<QueueItem | null> {
  const { items } = await agentQueue({ workspaceId, userId, take: 1 })
  return items[0] ?? null
}

/**
 * Loads one lead for the agent's working screen.
 *
 * Throws 404 rather than 403 for a lead assigned to someone else: an agent
 * should not be able to probe which ids exist in the workspace.
 */
export async function agentLead(workspaceId: string, userId: string, businessId: string) {
  const lead = await prisma.business.findFirst({
    where: { id: businessId, workspaceId, assignedToId: userId },
    include: {
      contacts: { orderBy: { createdAt: 'asc' } },
      outreach: { include: { notes: { orderBy: { createdAt: 'desc' }, take: 20 } } },
      callLogs: {
        orderBy: { createdAt: 'desc' },
        take: 25,
        include: { user: { select: { name: true, email: true } } },
      },
      sources: { select: { provider: true, retrievedAt: true } },
    },
  })
  if (!lead) throw new HttpError(404, 'Lead not found in your queue')
  return lead
}

/**
 * Hands the agent whatever is next and marks it as the lead they are on.
 *
 * There is no locking: two agents cannot collide because a lead belongs to
 * exactly one of them. Presence is recorded so the supervisor view can show
 * what each agent is working without the agent reporting it.
 */
export async function claimNext(workspaceId: string, userId: string) {
  const lead = await nextLead(workspaceId, userId)
  if (!lead) return null

  const { touchPresence } = await import('./sessions')
  await touchPresence({ workspaceId, userId, currentBusinessId: lead.id }).catch(() => {})
  return lead
}
