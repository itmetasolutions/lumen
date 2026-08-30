import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { ProfileEditor } from '@/components/crm/profile-editor'

export const metadata = { title: 'My profile' }
export const dynamic = 'force-dynamic'

export default async function SettingsProfilePage() {
  const auth = await requireAuth()

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.userId },
    select: { id: true, email: true, name: true, jobTitle: true, phone: true, avatarPath: true },
  })

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">My profile</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Your name and picture appear beside your work throughout the workspace.
        </p>
      </div>

      <ProfileEditor user={user} role={auth.role} workspaceName={auth.workspaceName} />
    </div>
  )
}
