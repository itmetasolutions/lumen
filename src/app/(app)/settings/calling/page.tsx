import { redirect } from 'next/navigation'
import { requireAuth } from '@/server/auth/guard'
import { COMMON_TIME_ZONES, crmSettings } from '@/server/crm/settings'
import { assignableAgents } from '@/server/crm/assignment'
import { CallingSettings } from '@/components/crm/calling-settings'

export const metadata = { title: 'Calling' }
export const dynamic = 'force-dynamic'

export default async function CallingSettingsPage() {
  const auth = await requireAuth()
  if (auth.role !== 'OWNER' && auth.role !== 'ADMIN') redirect('/settings/profile')

  const [settings, agents] = await Promise.all([
    crmSettings(auth.workspaceId),
    assignableAgents(auth.workspaceId),
  ])

  return (
    <CallingSettings
      initial={settings}
      timeZones={COMMON_TIME_ZONES}
      agentCount={agents.filter((a) => a.role === 'AGENT' || a.role === 'MEMBER').length}
    />
  )
}
