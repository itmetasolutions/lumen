import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { requireApiAuth } from '@/server/auth/guard'
import { getQueue } from '@/server/queue'
import { errorResponse } from '@/app/api/_lib/handler'

const schema = z.object({
  scopes: z
    .array(z.enum(['crawl', 'technical', 'seo', 'performance', 'ux']))
    .default(['crawl', 'technical', 'seo', 'performance', 'ux']),
  depth: z.enum(['QUICK', 'STANDARD', 'DEEP']).default('STANDARD'),
})

/**
 * §26 — targeted re-audit. Produces a NEW Audit row; previous audits are never
 * modified, which is what makes the historical comparison meaningful.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireApiAuth()
    const { id } = await params

    const business = await prisma.business.findFirst({
      where: { id, workspaceId: auth.workspaceId },
      select: { id: true, websiteUrl: true },
    })
    if (!business) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = schema.parse(await req.json().catch(() => ({})))

    // Crawling is a prerequisite for the analysis stages.
    const scopes = new Set(body.scopes)
    if (scopes.has('seo') || scopes.has('technical') || scopes.has('ux')) {
      scopes.add('crawl')
    }

    await prisma.business.update({
      where: { id },
      data: { auditStatus: 'QUEUED' },
    })

    const jobId = await getQueue().enqueue('audit.site', {
      businessId: id,
      workspaceId: auth.workspaceId,
      depth: body.depth,
      // 'manual' bypasses the performance result cache (§33).
      trigger: 'manual',
      scopes: Array.from(scopes),
    })

    return NextResponse.json({ queued: true, jobId })
  } catch (err) {
    return errorResponse(err)
  }
}
