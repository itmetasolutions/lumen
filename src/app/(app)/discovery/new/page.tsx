import { requireAuth } from '@/server/auth/guard'
import { providerStatuses } from '@/server/discovery/providers'
import { DiscoveryWizard } from '@/components/discovery/wizard'

export const metadata = { title: 'New Discovery' }

export default async function NewDiscoveryPage() {
  const auth = await requireAuth()

  // Probed live so the wizard can only offer sources that will actually work,
  // and can explain precisely why one is unavailable (§20, §21).
  const providers = await providerStatuses(auth.workspaceId)

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-7">
        <h1 className="text-xl font-semibold tracking-tight">New discovery</h1>
        <p className="mt-1 text-[13px] text-muted">
          Choose a market and an industry. Businesses are discovered across your selected
          sources, deduplicated into one record each, then audited in the background.
        </p>
      </div>

      <DiscoveryWizard providers={providers} />
    </div>
  )
}
