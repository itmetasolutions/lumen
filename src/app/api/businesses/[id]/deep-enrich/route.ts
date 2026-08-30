import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { requireApiAuth, requireRole } from '@/server/auth/guard'
import { deepEnrichBusiness } from '@/server/leads/deep-enrich'
import { errorResponse } from '@/app/api/_lib/handler'

const schema = z.object({
  useYelp: z.boolean().optional(),
})

/**
 * Deep enrichment for one business.
 *
 * Bounded to a single record on purpose: it crawls candidate domains and up to
 * ten pages of the business's own site, which is far too slow to run in bulk
 * inside a request. The bulk path stays on /api/leads/enrich-missing.
 *
 * Uses no paid search quota.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireApiAuth()
    requireRole(auth, 'MEMBER')
    const { id } = await params

    const body = schema.parse(await req.json().catch(() => ({})))

    const result = await deepEnrichBusiness({
      workspaceId: auth.workspaceId,
      businessId: id,
      useYelp: body.useYelp,
    })

    await prisma.auditLog.create({
      data: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        action: 'leads.deep_enrich',
        target: id,
        meta: {
          websiteFound: result.websiteFound,
          contactsAdded: result.contactsAdded,
          fieldsFilled: result.fieldsFilled,
        },
      },
    })

    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err)
  }
}
