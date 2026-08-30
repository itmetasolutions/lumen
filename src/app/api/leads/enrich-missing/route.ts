import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { requireRole } from '@/server/auth/guard'
import { querySchema } from '@/server/filters/schema'
import { enrichMissingContacts } from '@/server/leads/contact-enrichment'
import { route } from '@/app/api/_lib/handler'

const schema = z.object({
  ids: z.array(z.string().min(1)).max(200).optional(),
  query: querySchema.optional(),
  limit: z.number().int().min(1).max(50).default(25),
})

export const POST = route({ schema, limit: 'expensive' }, async ({ auth, body }) => {
  requireRole(auth, 'MEMBER')
  const result = await enrichMissingContacts({
    workspaceId: auth.workspaceId,
    ids: body.ids,
    query: body.query,
    limit: body.limit,
  })

  await prisma.auditLog.create({
    data: {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: 'leads.contacts.enrich',
      meta: {
        processed: result.processed,
        updated: result.updated,
        contactsAdded: result.contactsAdded,
        errors: result.errors.length,
      },
    },
  })

  return result
})
