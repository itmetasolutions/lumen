import { prisma } from '@/server/db/client'
import { scoringWeightsSchema, DEFAULT_WEIGHTS, parseWeights } from '@/server/scoring/weights'
import { requireRole } from '@/server/auth/guard'
import { route } from '@/app/api/_lib/handler'

/**
 * §14 — scoring weights are data, not code.
 *
 * Changing them affects how *future* audits are scored. Existing audit rows keep
 * the snapshot they were written with, so history stays interpretable.
 */

export const GET = route({ limit: 'read' }, async ({ auth }) => {
  const profile = await prisma.scoringProfile.findFirst({
    where: { workspaceId: auth.workspaceId, isDefault: true },
  })
  return {
    weights: profile ? parseWeights(profile.weights) : DEFAULT_WEIGHTS,
    defaults: DEFAULT_WEIGHTS,
    isCustom: Boolean(profile),
  }
})

export const PUT = route(
  { schema: scoringWeightsSchema, limit: 'write' },
  async ({ auth, body }) => {
    requireRole(auth, 'ADMIN')

    await prisma.scoringProfile.upsert({
      where: {
        workspaceId_name: { workspaceId: auth.workspaceId, name: 'Default' },
      },
      create: {
        workspaceId: auth.workspaceId,
        name: 'Default',
        isDefault: true,
        weights: body as unknown as object,
      },
      update: { weights: body as unknown as object },
    })

    await prisma.auditLog.create({
      data: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        action: 'scoring.update',
      },
    })

    return { ok: true }
  },
)
