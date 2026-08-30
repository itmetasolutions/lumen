import 'server-only'
import { randomBytes } from 'node:crypto'
import { prisma } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { hashPassword, passwordProblems } from '@/server/auth/password'
import type { Role } from '@prisma/client'

/**
 * Team administration.
 *
 * Agent accounts exist only because an admin created one. There is no
 * self-service registration path into an existing workspace: the register route
 * creates a *new* workspace with its own owner, and the agent build does not
 * ship a registration screen at all. That is the whole access model — if an
 * account can reach a workspace's leads, someone with authority put it there.
 *
 * Accounts are disabled rather than deleted. Their call history is the record
 * the reports are built from, and deleting the user would cascade it away.
 */

export interface TeamMember {
  userId: string
  membershipId: string
  email: string
  name: string | null
  jobTitle: string | null
  phone: string | null
  avatarPath: string | null
  role: Role
  isActive: boolean
  mustChangePassword: boolean
  lastLoginAt: Date | null
  createdAt: Date
  assignedLeads: number
  callsAllTime: number
}

export async function listTeam(workspaceId: string): Promise<TeamMember[]> {
  const members = await prisma.membership.findMany({
    where: { workspaceId },
    include: {
      user: {
        select: {
          id: true, email: true, name: true, jobTitle: true, phone: true,
          avatarPath: true, isActive: true, mustChangePassword: true,
          lastLoginAt: true, createdAt: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const userIds = members.map((m) => m.userId)
  const [leadCounts, callCounts] = await Promise.all([
    prisma.business.groupBy({
      by: ['assignedToId'],
      where: { workspaceId, assignedToId: { in: userIds } },
      _count: { _all: true },
    }),
    prisma.callLog.groupBy({
      by: ['userId'],
      where: { workspaceId, userId: { in: userIds } },
      _count: { _all: true },
    }),
  ])
  const leadsBy = new Map(leadCounts.map((c) => [c.assignedToId as string, c._count._all]))
  const callsBy = new Map(callCounts.map((c) => [c.userId, c._count._all]))

  return members.map((m) => ({
    userId: m.user.id,
    membershipId: m.id,
    email: m.user.email,
    name: m.user.name,
    jobTitle: m.user.jobTitle,
    phone: m.user.phone,
    avatarPath: m.user.avatarPath,
    role: m.role,
    isActive: m.user.isActive,
    mustChangePassword: m.user.mustChangePassword,
    lastLoginAt: m.user.lastLoginAt,
    createdAt: m.createdAt,
    assignedLeads: leadsBy.get(m.user.id) ?? 0,
    callsAllTime: callsBy.get(m.user.id) ?? 0,
  }))
}

/**
 * A first password the admin reads out once.
 *
 * Ambiguous characters are left out so it survives being dictated over a desk
 * or a phone line, which is how these actually get delivered.
 */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(14)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  // Guarantee the policy is met regardless of what the sampling produced.
  return `${out.slice(0, 12)}9Aa`
}

export interface CreateMemberInput {
  workspaceId: string
  actorRole: Role
  email: string
  name: string
  role: Role
  jobTitle?: string | null
  phone?: string | null
  /** Omit to have one generated and returned once. */
  password?: string
}

export interface CreatedMember {
  userId: string
  email: string
  /** Returned exactly once, at creation. Never stored in readable form. */
  temporaryPassword: string
}

export async function createMember(input: CreateMemberInput): Promise<CreatedMember> {
  const email = input.email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address')
  }
  assertCanGrant(input.actorRole, input.role)

  const password = input.password ?? generatePassword()
  const problems = passwordProblems(password)
  if (problems.length > 0) throw new HttpError(400, problems.join('. '))

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, memberships: { select: { workspaceId: true } } },
  })

  if (existing) {
    // The account exists somewhere. Adding it to this workspace is legitimate;
    // silently resetting its password would not be, so we never touch it.
    if (existing.memberships.some((m) => m.workspaceId === input.workspaceId)) {
      throw new HttpError(409, 'That person is already a member of this workspace')
    }
    await prisma.membership.create({
      data: { userId: existing.id, workspaceId: input.workspaceId, role: input.role },
    })
    throw new HttpError(
      409,
      'An account with that email already exists and has been added to this workspace. They sign in with their existing password.',
    )
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name.trim() || null,
      jobTitle: input.jobTitle?.trim() || null,
      phone: input.phone?.trim() || null,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      memberships: { create: { workspaceId: input.workspaceId, role: input.role } },
    },
    select: { id: true, email: true },
  })

  return { userId: user.id, email: user.email, temporaryPassword: password }
}

/**
 * Nobody may grant a role above their own — otherwise an admin could promote a
 * new account to OWNER and then use it to remove the actual owner.
 */
const GRANTABLE: Record<Role, Role[]> = {
  OWNER: ['OWNER', 'ADMIN', 'MEMBER', 'AGENT', 'VIEWER'],
  ADMIN: ['MEMBER', 'AGENT', 'VIEWER'],
  MEMBER: [],
  AGENT: [],
  VIEWER: [],
}

function assertCanGrant(actor: Role, target: Role): void {
  if (!GRANTABLE[actor].includes(target)) {
    throw new HttpError(403, `A ${actor.toLowerCase()} cannot grant the ${target} role`)
  }
}

export async function updateMember(params: {
  workspaceId: string
  actorId: string
  actorRole: Role
  userId: string
  name?: string | null
  jobTitle?: string | null
  phone?: string | null
  role?: Role
  isActive?: boolean
}): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: params.userId, workspaceId: params.workspaceId } },
    select: { role: true },
  })
  if (!membership) throw new HttpError(404, 'That person is not a member of this workspace')

  // Changing someone at or above your own level is out of bounds in both
  // directions: an admin may not demote an owner, nor edit another admin.
  if (params.userId !== params.actorId) {
    assertCanGrant(params.actorRole, membership.role)
  }
  if (params.role) assertCanGrant(params.actorRole, params.role)

  if (params.isActive === false || (params.role && params.role !== 'OWNER')) {
    await assertNotLastOwner(params.workspaceId, params.userId, membership.role)
  }

  await prisma.$transaction(async (tx) => {
    const userData: Record<string, unknown> = {}
    if (params.name !== undefined) userData.name = params.name?.trim() || null
    if (params.jobTitle !== undefined) userData.jobTitle = params.jobTitle?.trim() || null
    if (params.phone !== undefined) userData.phone = params.phone?.trim() || null
    if (params.isActive !== undefined) userData.isActive = params.isActive

    if (Object.keys(userData).length > 0) {
      await tx.user.update({ where: { id: params.userId }, data: userData })
    }
    if (params.role) {
      await tx.membership.update({
        where: { userId_workspaceId: { userId: params.userId, workspaceId: params.workspaceId } },
        data: { role: params.role },
      })
    }

    // A disabled agent must not keep holding leads nobody is calling.
    if (params.isActive === false) {
      await tx.business.updateMany({
        where: { workspaceId: params.workspaceId, assignedToId: params.userId },
        data: { assignedToId: null, assignedAt: null },
      })
      await tx.leadAssignment.updateMany({
        where: {
          workspaceId: params.workspaceId,
          assignedToId: params.userId,
          releasedAt: null,
        },
        data: { releasedAt: new Date(), reason: 'Account disabled' },
      })
      await tx.workSession.updateMany({
        where: { workspaceId: params.workspaceId, userId: params.userId, endedAt: null },
        data: { endedAt: new Date(), endedBy: 'auto' },
      })
      await tx.agentPresence.updateMany({
        where: { userId: params.userId },
        data: { status: 'offline', currentBusinessId: null, currentSessionId: null },
      })
    }
  })
}

async function assertNotLastOwner(
  workspaceId: string,
  userId: string,
  currentRole: Role,
): Promise<void> {
  if (currentRole !== 'OWNER') return
  const owners = await prisma.membership.count({
    where: { workspaceId, role: 'OWNER', user: { isActive: true } },
  })
  if (owners <= 1) {
    throw new HttpError(400, 'This is the only owner — promote someone else first')
  }
}

export async function resetMemberPassword(params: {
  workspaceId: string
  actorRole: Role
  userId: string
}): Promise<{ temporaryPassword: string }> {
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: params.userId, workspaceId: params.workspaceId } },
    select: { role: true },
  })
  if (!membership) throw new HttpError(404, 'That person is not a member of this workspace')
  assertCanGrant(params.actorRole, membership.role)

  const password = generatePassword()
  await prisma.user.update({
    where: { id: params.userId },
    data: { passwordHash: await hashPassword(password), mustChangePassword: true },
  })
  return { temporaryPassword: password }
}

/** Self-service profile edit — the one thing an agent may change about itself. */
export async function updateOwnProfile(params: {
  userId: string
  name?: string
  jobTitle?: string | null
  phone?: string | null
  avatarPath?: string | null
}): Promise<void> {
  const data: Record<string, unknown> = {}
  if (params.name !== undefined) data.name = params.name.trim() || null
  if (params.jobTitle !== undefined) data.jobTitle = params.jobTitle?.trim() || null
  if (params.phone !== undefined) data.phone = params.phone?.trim() || null
  if (params.avatarPath !== undefined) data.avatarPath = params.avatarPath
  if (Object.keys(data).length === 0) return
  await prisma.user.update({ where: { id: params.userId }, data })
}

export async function changeOwnPassword(params: {
  userId: string
  current: string
  next: string
}): Promise<void> {
  const { verifyPassword } = await import('@/server/auth/password')
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { passwordHash: true },
  })
  if (!user) throw new HttpError(404, 'Account not found')
  if (!(await verifyPassword(params.current, user.passwordHash))) {
    throw new HttpError(400, 'Your current password is not correct')
  }
  const problems = passwordProblems(params.next)
  if (problems.length > 0) throw new HttpError(400, problems.join('. '))
  if (params.current === params.next) {
    throw new HttpError(400, 'The new password must be different from the current one')
  }

  await prisma.user.update({
    where: { id: params.userId },
    data: { passwordHash: await hashPassword(params.next), mustChangePassword: false },
  })
}
