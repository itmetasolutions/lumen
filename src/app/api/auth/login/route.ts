import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { verifyPassword } from '@/server/auth/password'
import { setSessionCookie } from '@/server/auth/session'
import { route, HttpError } from '@/app/api/_lib/handler'

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
})

export const POST = route(
  { schema, limit: 'auth', authenticated: false },
  async ({ body }) => {
    const email = body.email.trim().toLowerCase()

    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { orderBy: { createdAt: 'asc' }, take: 1 } },
    })

    // Same message and comparable timing whether the account exists or not, so
    // the endpoint cannot be used to enumerate registered emails.
    const valid = user ? await verifyPassword(body.password, user.passwordHash) : false
    if (!user || !valid) throw new HttpError(401, 'Email or password is incorrect')

    const membership = user.memberships[0]
    if (!membership) throw new HttpError(403, 'This account has no workspace')

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    await setSessionCookie({
      userId: user.id,
      workspaceId: membership.workspaceId,
      email: user.email,
    })

    return { ok: true }
  },
)
