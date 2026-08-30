import { z } from 'zod'
import { requireRole } from '@/server/auth/guard'
import {
  createMember,
  listTeam,
  resetMemberPassword,
  updateMember,
} from '@/server/crm/team'
import { route } from '@/app/api/_lib/handler'

/**
 * Team administration.
 *
 * Creating an account is the only way into a workspace, so this endpoint is the
 * access-control boundary for the whole agent app. It is ADMIN-gated, and the
 * service refuses to grant a role above the caller's own.
 */

const createSchema = z.object({
  action: z.literal('create'),
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  role: z.enum(['ADMIN', 'MEMBER', 'AGENT', 'VIEWER']),
  jobTitle: z.string().max(120).nullish(),
  phone: z.string().max(40).nullish(),
})

const updateSchema = z.object({
  action: z.literal('update'),
  userId: z.string().min(1).max(40),
  name: z.string().max(120).nullish(),
  jobTitle: z.string().max(120).nullish(),
  phone: z.string().max(40).nullish(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'AGENT', 'VIEWER']).optional(),
  isActive: z.boolean().optional(),
})

const resetSchema = z.object({
  action: z.literal('reset-password'),
  userId: z.string().min(1).max(40),
})

const schema = z.discriminatedUnion('action', [createSchema, updateSchema, resetSchema])

export const GET = route({ limit: 'read' }, async ({ auth }) => {
  requireRole(auth, 'ADMIN')
  return { members: await listTeam(auth.workspaceId) }
})

export const POST = route({ schema, limit: 'write' }, async ({ auth, body }) => {
  requireRole(auth, 'ADMIN')

  switch (body.action) {
    case 'create': {
      const created = await createMember({
        workspaceId: auth.workspaceId,
        actorRole: auth.role,
        email: body.email,
        name: body.name,
        role: body.role,
        jobTitle: body.jobTitle,
        phone: body.phone,
      })
      // The temporary password is returned once and never again — there is no
      // endpoint that reads it back, because it is only stored as a hash.
      return created
    }

    case 'update':
      await updateMember({
        workspaceId: auth.workspaceId,
        actorId: auth.userId,
        actorRole: auth.role,
        userId: body.userId,
        name: body.name,
        jobTitle: body.jobTitle,
        phone: body.phone,
        role: body.role,
        isActive: body.isActive,
      })
      return { ok: true }

    case 'reset-password':
      return resetMemberPassword({
        workspaceId: auth.workspaceId,
        actorRole: auth.role,
        userId: body.userId,
      })
  }
})
