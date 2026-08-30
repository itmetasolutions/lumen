import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { AuditRulesEditor } from '@/components/settings/audit-rules-editor'

export const metadata = { title: 'Audit rules' }
export const dynamic = 'force-dynamic'

export default async function AuditRulesPage() {
  const auth = await requireAuth()

  const settings =
    (await prisma.workspaceSettings.findUnique({
      where: { workspaceId: auth.workspaceId },
    })) ??
    (await prisma.workspaceSettings.create({
      data: { workspaceId: auth.workspaceId },
    }))

  return (
    <AuditRulesEditor
      initial={{
        maxBusinessesPerDiscovery: settings.maxBusinessesPerDiscovery,
        maxPagesPerSite: settings.maxPagesPerSite,
        maxConcurrentAudits: settings.maxConcurrentAudits,
        dailyPerformanceTests: settings.dailyPerformanceTests,
        dailyAiAnalyses: settings.dailyAiAnalyses,
        performanceCacheHours: settings.performanceCacheHours,
        aiCacheHours: settings.aiCacheHours,
      }}
      canEdit={auth.role === 'OWNER' || auth.role === 'ADMIN'}
    />
  )
}
