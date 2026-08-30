import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { requireRole } from '@/server/auth/guard'
import { route } from '@/app/api/_lib/handler'

/** §33/§34 — cost controls and audit thresholds, per workspace. */

const schema = z.object({
  maxBusinessesPerDiscovery: z.number().int().min(1).max(50_000),
  maxPagesPerSite: z.number().int().min(1).max(200),
  maxConcurrentAudits: z.number().int().min(1).max(32),
  dailyPerformanceTests: z.number().int().min(0).max(100_000),
  dailyAiAnalyses: z.number().int().min(0).max(100_000),
  performanceCacheHours: z.number().int().min(0).max(8760),
  aiCacheHours: z.number().int().min(0).max(8760),
})

export const GET = route({ limit: 'read' }, async ({ auth }) => {
  const settings = await prisma.workspaceSettings.findUnique({
    where: { workspaceId: auth.workspaceId },
  })
  return { settings }
})

export const PUT = route({ schema, limit: 'write' }, async ({ auth, body }) => {
  requireRole(auth, 'ADMIN')

  const settings = await prisma.workspaceSettings.upsert({
    where: { workspaceId: auth.workspaceId },
    create: { workspaceId: auth.workspaceId, ...body },
    update: body,
  })

  await prisma.auditLog.create({
    data: {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: 'settings.audit_rules.update',
      meta: body,
    },
  })

  return { settings }
})
