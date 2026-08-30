import 'server-only'
import { redirect } from 'next/navigation'
import { prisma } from '@/server/db/client'
import { readSession, type SessionPayload } from './session'
import type { Role } from '@prisma/client'

export interface AuthContext extends SessionPayload {
  role: Role
  workspaceName: string
  userName: string | null
}

/**
 * §29 — workspace isolation. Every authenticated path resolves its context here,
 * and the membership row is re-checked on every request: a session token alone is
 * never sufficient proof of access to a workspace.
 */
export async function getAuth(): Promise<AuthContext | null> {
  const session = await readSession()
  if (!session) return null

  const membership = await prisma.membership.findUnique({
    where: {
      userId_workspaceId: {
        userId: session.userId,
        workspaceId: session.workspaceId,
      },
    },
    include: {
      workspace: { select: { name: true } },
      user: { select: { name: true } },
    },
  })
  if (!membership) return null

  return {
    ...session,
    role: membership.role,
    workspaceName: membership.workspace.name,
    userName: membership.user.name,
  }
}

/** For server components / pages — bounces to login. */
export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuth()
  if (!auth) redirect('/login')
  return auth
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** For route handlers — throws, so the handler wrapper can render JSON. */
export async function requireApiAuth(): Promise<AuthContext> {
  const auth = await getAuth()
  if (!auth) throw new HttpError(401, 'Authentication required')
  return auth
}

const RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 }

export function requireRole(auth: AuthContext, min: Role): void {
  if (RANK[auth.role] < RANK[min]) {
    throw new HttpError(403, `Requires ${min} role or higher`)
  }
}
