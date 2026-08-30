import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { ProfileEditor } from '@/components/crm/profile-editor'

export const metadata = { title: 'Profile' }
export const dynamic = 'force-dynamic'

export default async function AgentProfilePage() {
  const auth = await requireAuth()

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.userId },
    select: {
      id: true, email: true, name: true, jobTitle: true,
      phone: true, avatarPath: true, lastLoginAt: true, createdAt: true,
    },
  })

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
      <p className="mb-5 mt-1 text-[13px] text-muted">
        Your name and picture are what your supervisor and teammates see beside
        your work. Your role and the leads assigned to you are set by your
        supervisor.
      </p>

      <ProfileEditor
        user={{
          id: user.id,
          email: user.email,
          name: user.name,
          jobTitle: user.jobTitle,
          phone: user.phone,
          avatarPath: user.avatarPath,
        }}
        role={auth.role}
        workspaceName={auth.workspaceName}
      />
    </div>
  )
}
