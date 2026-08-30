import { providerStatuses } from '@/server/discovery/providers'
import { performanceProviders } from '@/server/audit/performance'
import { aiProviderStatus } from '@/server/ai'
import { storageStatus } from '@/server/storage'
import { getQueue } from '@/server/queue'
import { launchBrowser } from '@/server/audit/ux/browser'
import { env } from '@/server/env'
import { route } from '@/app/api/_lib/handler'

/**
 * Settings → Integrations (§20).
 *
 * Probes every adapter live and returns Connected / Not Connected / Error with
 * an actionable reason. **No secret values are ever returned** — only whether a
 * credential is present and what the provider said when we used it.
 */
export const GET = route({ limit: 'expensive' }, async ({ auth }) => {
  const [discovery, ai] = await Promise.all([
    providerStatuses(auth.workspaceId),
    aiProviderStatus(auth.workspaceId),
  ])

  const performance = await Promise.all(
    performanceProviders().map(async (p) => {
      let status
      try {
        status = await p.configured(auth.workspaceId)
      } catch (err) {
        status = { state: 'ERROR' as const, detail: (err as Error).message }
      }
      return { id: p.id, label: p.label, isDemo: p.isDemo, status }
    }),
  )

  // The browser check is what determines whether UX audits can run at all.
  let browser: { state: 'CONNECTED' | 'ERROR'; detail: string }
  try {
    const handle = await launchBrowser()
    await handle.close()
    browser = {
      state: 'CONNECTED',
      detail: `Browser available via channel "${env.playwrightChannel}". UX audits and screenshots are enabled.`,
    }
  } catch (err) {
    browser = { state: 'ERROR', detail: (err as Error).message }
  }

  const queue = getQueue()
  const counts = await Promise.all(
    ['discovery', 'audit', 'export'].map(async (q) => ({
      queue: q,
      counts: await queue.counts(q).catch(() => ({})),
    })),
  )

  return {
    discovery,
    performance,
    ai,
    storage: await storageStatus(auth.workspaceId),
    browser,
    queue: { driver: queue.driver, queues: counts },
  }
})
