import { redirect } from 'next/navigation'
import { getAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { currentSession } from '@/server/crm/sessions'
import { queueCounts } from '@/server/crm/queue'
import { AgentShell } from '@/components/agent/agent-shell'

/**
 * The agent application.
 *
 * A deliberately small surface: a queue, a lead, a shift clock and a profile.
 * There is no navigation to discovery, exports, imports or other agents' work,
 * and the API routes behind those refuse an AGENT anyway — the missing menu
 * items are a convenience, not the access control.
 *
 * Supervisors can open this too, to see what their agents see. They are not
 * redirected away, because the fastest way to answer "why can't I find that
 * lead" is to look at the same screen.
 */
export default async function AgentLayout({ children }: { children: React.ReactNode }) {
  // Not requireAuth(): that bounces to a bare /login, which offers to create a
  // new workspace. An agent needs the login-only form and to land back here.
  const auth = await getAuth()
  if (!auth) redirect('/login?next=%2Fagent')
  if (auth.role === 'VIEWER') redirect('/dashboard')

  const [user, session, counts] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { id: true, name: true, email: true, avatarPath: true, mustChangePassword: true },
    }),
    currentSession(auth.workspaceId, auth.userId),
    queueCounts(auth.workspaceId, auth.userId).catch(() => ({
      overdue: 0, today: 0, new: 0, working: 0, upcoming: 0, total: 0,
    })),
  ])

  return (
    <AgentShell
      user={{
        id: user.id,
        name: user.name,
        email: user.email,
        avatarPath: user.avatarPath,
        mustChangePassword: user.mustChangePassword,
      }}
      workspaceName={auth.workspaceName}
      isSupervisor={auth.role === 'OWNER' || auth.role === 'ADMIN'}
      initialSession={
        session
          ? {
              id: session.id,
              startedAt: session.startedAt.toISOString(),
              activeSeconds: session.activeSeconds,
              shiftSeconds: session.shiftSeconds,
            }
          : null
      }
      counts={counts}
    >
      {children}
    </AgentShell>
  )
}
