import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { hashPassword, passwordProblems } from '@/server/auth/password'
import { isSecureRequest, setSessionCookie } from '@/server/auth/session'
import { DEFAULT_WEIGHTS } from '@/server/scoring/weights'
import { route, HttpError } from '@/app/api/_lib/handler'

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  name: z.string().max(120).optional(),
  workspaceName: z.string().min(1).max(120).default('My Workspace'),
})

export const POST = route(
  { schema, limit: 'auth', authenticated: false },
  async ({ body, req }) => {
    const email = body.email.trim().toLowerCase()

    const problems = passwordProblems(body.password)
    if (problems.length > 0) {
      throw new HttpError(400, `Password requirements: ${problems.join(', ')}`)
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new HttpError(409, 'An account with that email already exists')

    const passwordHash = await hashPassword(body.password)
    const slug = `${slugify(body.workspaceName)}-${Math.random().toString(36).slice(2, 7)}`

    // The first user of a workspace owns it, and the workspace is created with
    // its default scoring profile and settings so nothing is half-configured.
    const { user, workspace } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name: body.name?.trim() || null, passwordHash },
      })
      const workspace = await tx.workspace.create({
        data: {
          name: body.workspaceName.trim(),
          slug,
          memberships: { create: { userId: user.id, role: 'OWNER' } },
          settings: { create: {} },
          scoringProfiles: {
            create: {
              name: 'Default',
              isDefault: true,
              weights: DEFAULT_WEIGHTS as unknown as object,
            },
          },
        },
      })
      return { user, workspace }
    })

    await setSessionCookie(
      {
        userId: user.id,
        workspaceId: workspace.id,
        email: user.email,
      },
      { secure: isSecureRequest(req) },
    )

    return { ok: true, workspaceId: workspace.id }
  },
)

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'workspace'
  )
}
