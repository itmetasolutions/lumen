import { prisma } from '@/server/db/client'
import { requireRole } from '@/server/auth/guard'
import { deleteNoContactLeads } from '@/server/leads/contact-enrichment'
import { route } from '@/app/api/_lib/handler'

export const DELETE = route({ limit: 'write' }, async ({ auth }) => {
  requireRole(auth, 'ADMIN')
  const deleted = await deleteNoContactLeads(auth.workspaceId)

  await prisma.auditLog.create({
    data: {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: 'leads.no_contact.delete',
      meta: { deleted },
    },
  })

  return { deleted }
})
