import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { filterGroupSchema, sortSchema, dateRangeSchema, TABS } from '@/server/filters/schema'
import { route, HttpError } from '@/app/api/_lib/handler'

/**
 * Saved views (§38) — a view remembers the tab, filters, sort, columns and date
 * range together, because restoring only some of those would not reproduce what
 * the user saved.
 */

const schema = z.object({
  name: z.string().min(1).max(80),
  tab: z.enum(TABS),
  filters: filterGroupSchema,
  sort: sortSchema.optional(),
  columns: z.array(z.string().max(60)).max(80).default([]),
  dateRange: dateRangeSchema.optional(),
  isShared: z.boolean().default(true),
})

export const GET = route({ limit: 'read' }, async ({ auth }) => {
  const views = await prisma.savedView.findMany({
    where: { workspaceId: auth.workspaceId },
    orderBy: { updatedAt: 'desc' },
    include: { createdBy: { select: { name: true, email: true } } },
  })
  return { views }
})

export const POST = route({ schema, limit: 'write' }, async ({ auth, body }) => {
  const view = await prisma.savedView.upsert({
    where: { workspaceId_name: { workspaceId: auth.workspaceId, name: body.name } },
    create: {
      workspaceId: auth.workspaceId,
      createdById: auth.userId,
      name: body.name,
      tab: body.tab,
      filters: body.filters as unknown as object,
      sort: (body.sort ?? null) as unknown as object,
      columns: body.columns,
      dateRange: (body.dateRange ?? null) as unknown as object,
      isShared: body.isShared,
    },
    // Saving over an existing name updates it, which is what "Save view" means
    // when the user reuses a name they already have.
    update: {
      tab: body.tab,
      filters: body.filters as unknown as object,
      sort: (body.sort ?? null) as unknown as object,
      columns: body.columns,
      dateRange: (body.dateRange ?? null) as unknown as object,
      isShared: body.isShared,
    },
    select: { id: true, name: true },
  })
  return view
})

export const DELETE = route(
  { schema: z.object({ id: z.string().max(40) }), limit: 'write' },
  async ({ auth, body }) => {
    const existing = await prisma.savedView.findFirst({
      where: { id: body.id, workspaceId: auth.workspaceId },
      select: { id: true },
    })
    if (!existing) throw new HttpError(404, 'Saved view not found')
    await prisma.savedView.delete({ where: { id: body.id } })
    return { ok: true }
  },
)
