import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { DEFAULT_WEIGHTS, parseWeights } from '@/server/scoring/weights'
import { ScoringEditor } from '@/components/settings/scoring-editor'

export const metadata = { title: 'Scoring' }
export const dynamic = 'force-dynamic'

export default async function ScoringPage() {
  const auth = await requireAuth()
  const profile = await prisma.scoringProfile.findFirst({
    where: { workspaceId: auth.workspaceId, isDefault: true },
  })

  return (
    <ScoringEditor
      initial={profile ? parseWeights(profile.weights) : DEFAULT_WEIGHTS}
      defaults={DEFAULT_WEIGHTS}
      canEdit={auth.role === 'OWNER' || auth.role === 'ADMIN'}
    />
  )
}
