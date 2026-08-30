import { querySchema } from '@/server/filters/schema'
import { matchingIds } from '@/server/leads/query'
import { route } from '@/app/api/_lib/handler'

/**
 * Returns every id matching the current filter, so "select all N matching" can
 * act on rows the user has not scrolled to. Capped so a runaway selection
 * cannot build a multi-megabyte request body.
 */
export const POST = route({ schema: querySchema, limit: 'read' }, async ({ auth, body }) => {
  const ids = await matchingIds(auth.workspaceId, body)
  return { ids, truncated: ids.length >= 10_000 }
})
