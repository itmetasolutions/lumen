import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { getQueue } from '@/server/queue'
import { querySchema, TABS } from '@/server/filters/schema'
import { COLUMN_MAP, DEFAULT_EXPORT_COLUMNS } from '@/server/export/columns'
import { compileQuery } from '@/server/filters/compile'
import { route, HttpError } from '@/app/api/_lib/handler'

/**
 * Export creation (§9, §37).
 *
 * The row count is computed here, with the *same* compiler the table uses, and
 * returned immediately — so the UI can say "exporting 327 businesses" and the
 * user can verify it matches what they were looking at before the file lands.
 */

const schema = z.object({
  format: z.enum(['CSV', 'XLSX']),
  scope: z.enum(['ALL', 'FILTER', 'SELECTED']),
  tab: z.enum(TABS).default('all'),
  query: querySchema.optional(),
  ids: z.array(z.string().max(40)).max(50_000).default([]),
  columns: z.array(z.string().max(60)).max(80).default([]),
})

export const POST = route({ schema, limit: 'expensive' }, async ({ auth, body }) => {
  if (body.scope === 'SELECTED' && body.ids.length === 0) {
    throw new HttpError(400, 'No rows were selected')
  }

  const unknownColumns = body.columns.filter((c) => !COLUMN_MAP.has(c))
  if (unknownColumns.length > 0) {
    throw new HttpError(400, `Unknown export column(s): ${unknownColumns.join(', ')}`)
  }

  const query = body.query ?? querySchema.parse({ tab: body.tab })

  // Count now, using the identical where-clause the export job will use.
  const where =
    body.scope === 'SELECTED'
      ? { workspaceId: auth.workspaceId, id: { in: body.ids } }
      : body.scope === 'ALL'
        ? compileQuery(auth.workspaceId, {
            ...query,
            filters: { logic: 'AND' as const, conditions: [] },
            search: undefined,
            dateRange: undefined,
          })
        : compileQuery(auth.workspaceId, query)

  const rowCount = await prisma.business.count({ where })
  if (rowCount === 0) throw new HttpError(400, 'That selection contains no businesses')

  const job = await prisma.exportJob.create({
    data: {
      workspaceId: auth.workspaceId,
      createdById: auth.userId,
      format: body.format,
      scope: body.scope,
      tab: body.tab,
      // Persisted so the worker rebuilds exactly this filter, not a fresh one.
      filters: body.scope === 'SELECTED' ? undefined : (query as unknown as object),
      ids: body.scope === 'SELECTED' ? body.ids : [],
      columns: body.columns.length > 0 ? body.columns : DEFAULT_EXPORT_COLUMNS,
      state: 'PENDING',
    },
    select: { id: true },
  })

  await getQueue().enqueue('export.run', {
    exportJobId: job.id,
    workspaceId: auth.workspaceId,
  })

  return { id: job.id, expectedRows: rowCount }
})

export const GET = route({ limit: 'read' }, async ({ auth }) => {
  const jobs = await prisma.exportJob.findMany({
    where: { workspaceId: auth.workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: {
      id: true,
      format: true,
      scope: true,
      tab: true,
      state: true,
      rowCount: true,
      fileName: true,
      bytes: true,
      error: true,
      createdAt: true,
      completedAt: true,
    },
  })
  return { jobs }
})
