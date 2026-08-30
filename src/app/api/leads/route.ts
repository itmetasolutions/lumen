import { querySchema } from '@/server/filters/schema'
import { listLeads, tabCounts } from '@/server/leads/query'
import { route } from '@/app/api/_lib/handler'

/**
 * The table's data endpoint (§22).
 *
 * Filtering, sorting, searching and pagination all happen in Postgres; the
 * response carries one page plus the counts the tab strip needs.
 */
export const POST = route({ schema: querySchema, limit: 'read' }, async ({ auth, body }) => {
  const [page, counts] = await Promise.all([
    listLeads(auth.workspaceId, body),
    tabCounts(auth.workspaceId, body),
  ])
  return { ...page, counts }
})

export const GET = route({ schema: querySchema, limit: 'read' }, async ({ auth, body }) => {
  const [page, counts] = await Promise.all([
    listLeads(auth.workspaceId, body),
    tabCounts(auth.workspaceId, body),
  ])
  return { ...page, counts }
})
