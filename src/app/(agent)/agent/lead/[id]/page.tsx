import { notFound } from 'next/navigation'
import { requireAuth } from '@/server/auth/guard'
import { HttpError } from '@/server/auth/guard'
import { agentLead, nextLead } from '@/server/crm/queue'
import { crmSettings } from '@/server/crm/settings'
import { currentSession } from '@/server/crm/sessions'
import { OUTCOMES } from '@/server/crm/outcomes'
import { CallWorkspace } from '@/components/agent/call-workspace'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  const { id } = await params
  try {
    const lead = await agentLead(auth.workspaceId, auth.userId, id)
    return { title: lead.name }
  } catch {
    return { title: 'Lead' }
  }
}

export default async function AgentLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  const { id } = await params

  let lead
  try {
    lead = await agentLead(auth.workspaceId, auth.userId, id)
  } catch (err) {
    // A lead that is not in this agent's queue is indistinguishable from one
    // that does not exist — deliberately, so ids cannot be probed.
    if (err instanceof HttpError && err.status === 404) notFound()
    throw err
  }

  const [settings, session, upNext] = await Promise.all([
    crmSettings(auth.workspaceId),
    currentSession(auth.workspaceId, auth.userId),
    nextLead(auth.workspaceId, auth.userId),
  ])

  return (
    <CallWorkspace
      lead={{
        id: lead.id,
        name: lead.name,
        primaryPhone: lead.primaryPhone,
        primaryEmail: lead.primaryEmail,
        websiteUrl: lead.websiteUrl,
        addressLine: lead.addressLine,
        city: lead.city,
        region: lead.region,
        postalCode: lead.postalCode,
        country: lead.country,
        category: lead.category,
        categories: lead.categories,
        rating: lead.rating,
        reviewCount: lead.reviewCount,
        leadScore: lead.leadScore,
        callCount: lead.callCount,
        nextFollowUpAt: lead.nextFollowUpAt?.toISOString() ?? null,
        lastCallOutcome: lead.lastCallOutcome,
        isDemo: lead.isDemo,
        needsWebsite: lead.needsWebsite,
        needsRedesign: lead.needsRedesign,
        needsSeo: lead.needsSeo,
        needsSpeed: lead.needsSpeed,
        stage: lead.outreach?.stage ?? null,
        // Every phone, email and social profile the pipeline actually found,
        // with the provider that supplied each one (§19).
        contacts: lead.contacts.map((c) => ({
          id: c.id,
          kind: c.kind,
          value: c.value,
          label: c.label,
          isPrimary: c.isPrimary,
          provider: c.provider,
        })),
        calls: lead.callLogs.map((c) => ({
          id: c.id,
          outcome: c.outcome,
          contactReached: c.contactReached,
          notes: c.notes,
          durationSec: c.durationSec,
          followUpAt: c.followUpAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
          by: c.user.name ?? c.user.email,
        })),
      }}
      outcomes={OUTCOMES}
      requireClockIn={settings.requireClockIn}
      clockedIn={Boolean(session)}
      nextLeadId={upNext && upNext.id !== lead.id ? upNext.id : null}
    />
  )
}
