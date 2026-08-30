import { requireAuth } from '@/server/auth/guard'
import { redirect } from 'next/navigation'
import { listTeam } from '@/server/crm/team'
import { TeamManager } from '@/components/crm/team-manager'

export const metadata = { title: 'Team' }
export const dynamic = 'force-dynamic'

export default async function TeamPage() {
  const auth = await requireAuth()
  if (auth.role !== 'OWNER' && auth.role !== 'ADMIN') redirect('/dashboard')

  const members = await listTeam(auth.workspaceId)

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 max-w-3xl text-[13px] text-muted">
          Accounts are created here and nowhere else — there is no sign-up page
          for this workspace. Agents sign in to the Lumen Agent app with the
          password you give them and are asked to change it on first use.
        </p>
      </div>

      <TeamManager
        initialMembers={members}
        actorRole={auth.role}
        actorId={auth.userId}
      />
    </div>
  )
}
