import { redirect } from 'next/navigation'
import { requireAuth } from '@/server/auth/guard'
import { sidebarCounts } from '@/server/leads/query'
import { Sidebar } from '@/components/shell/sidebar'
import { Topbar } from '@/components/shell/topbar'

/**
 * Application shell.
 *
 * Desktop-first by design (§35): the primary surface is a dense data table that
 * people work in for long sessions on a large screen.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const auth = await requireAuth()

  // Agents do not have an admin app. Every route under this layout assumes a
  // supervisor's view of the whole workspace, so rather than hiding controls
  // one by one, the whole shell is closed to them and they land in their own.
  if (auth.role === 'AGENT') redirect('/agent')

  // A fresh workspace has no businesses yet; failing to count must not blank
  // the whole application shell.
  const counts = await sidebarCounts(auth.workspaceId).catch(() => ({
    all: 0,
    'website-creation': 0,
    redesign: 0,
    seo: 0,
    speed: 0,
    hot: 0,
    new: 0,
  }))

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar counts={counts} workspaceName={auth.workspaceName} role={auth.role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar email={auth.email} userName={auth.userName} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
