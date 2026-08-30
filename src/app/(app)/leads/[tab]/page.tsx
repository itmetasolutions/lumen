import { notFound } from 'next/navigation'
import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { TABS, TAB_LABELS, type TabId } from '@/server/filters/schema'
import { assignableAgents } from '@/server/crm/assignment'
import { LeadsWorkspace } from '@/components/data-table/leads-workspace'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tab: string }>
}) {
  const { tab } = await params
  return { title: TAB_LABELS[tab as TabId] ?? 'Leads' }
}

export default async function LeadsPage({
  params,
}: {
  params: Promise<{ tab: string }>
}) {
  const { tab } = await params
  if (!TABS.includes(tab as TabId)) notFound()

  const auth = await requireAuth()

  // Only a supervisor can hand work out, so only they are given the list.
  const canAssign = auth.role === 'OWNER' || auth.role === 'ADMIN'
  const agents = canAssign ? await assignableAgents(auth.workspaceId) : []

  const views = await prisma.savedView.findMany({
    where: { workspaceId: auth.workspaceId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      tab: true,
      filters: true,
      sort: true,
      columns: true,
      dateRange: true,
    },
  })

  return (
    <div className="h-full">
      <LeadsWorkspace
        tab={tab as TabId}
        savedViews={views as never}
        agents={agents.map((a) => ({ id: a.id, name: a.name, openLeads: a.openLeads }))}
      />
    </div>
  )
}
