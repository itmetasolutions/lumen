import { requireAuth } from '@/server/auth/guard'
import { agentQueue, queueCounts } from '@/server/crm/queue'
import { AgentQueue } from '@/components/agent/agent-queue'

export const metadata = { title: 'My queue' }
export const dynamic = 'force-dynamic'

/**
 * The agent's queue.
 *
 * Rendered server-side on first load so an agent who opens the app at 9am sees
 * their work immediately rather than a spinner. Bucket switching and search
 * refetch from /api/crm/queue.
 */
export default async function AgentQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string }>
}) {
  const auth = await requireAuth()
  const params = await searchParams

  const bucket = isBucket(params.bucket) ? params.bucket : 'all'

  const [page, counts] = await Promise.all([
    agentQueue({ workspaceId: auth.workspaceId, userId: auth.userId, bucket, take: 50 }),
    queueCounts(auth.workspaceId, auth.userId),
  ])

  return (
    <AgentQueue
      initialItems={page.items.map((i) => ({
        ...i,
        lastCallAt: i.lastCallAt?.toISOString() ?? null,
        nextFollowUpAt: i.nextFollowUpAt?.toISOString() ?? null,
      }))}
      initialTotal={page.total}
      initialCounts={counts}
      initialBucket={bucket}
    />
  )
}

const BUCKETS = ['all', 'overdue', 'today', 'new', 'working', 'upcoming'] as const

function isBucket(v: string | undefined): v is (typeof BUCKETS)[number] {
  return typeof v === 'string' && (BUCKETS as readonly string[]).includes(v)
}
