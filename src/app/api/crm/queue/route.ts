import { z } from 'zod'
import { requireRole } from '@/server/auth/guard'
import { agentQueue, claimNext, queueCounts } from '@/server/crm/queue'
import { route } from '@/app/api/_lib/handler'

/**
 * The agent's own queue.
 *
 * Every read here is scoped to the caller's user id inside the service — there
 * is no parameter for "whose queue", because an agent asking for someone else's
 * is not a request this endpoint should be able to express.
 */

const schema = z.object({
  bucket: z.enum(['all', 'overdue', 'today', 'new', 'working', 'upcoming']).default('all'),
  search: z.string().max(120).optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).max(100_000).default(0),
  /** Ask for the next lead to work rather than a page of them. */
  next: z.coerce.boolean().default(false),
})

export const GET = route({ schema, limit: 'read' }, async ({ auth, body }) => {
  requireRole(auth, 'AGENT')

  if (body.next) {
    const lead = await claimNext(auth.workspaceId, auth.userId)
    return { lead }
  }

  const [page, counts] = await Promise.all([
    agentQueue({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      bucket: body.bucket,
      search: body.search,
      take: body.take,
      skip: body.skip,
    }),
    queueCounts(auth.workspaceId, auth.userId),
  ])

  return { ...page, counts }
})
