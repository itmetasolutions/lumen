import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { requireApiAuth } from '@/server/auth/guard'
import { errorResponse } from '@/app/api/_lib/handler'

const schema = z.object({
  stage: z
    .enum([
      'NOT_CONTACTED', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'QUALIFIED',
      'PROPOSAL_SENT', 'WON', 'LOST', 'NOT_INTERESTED', 'DO_NOT_CONTACT',
    ])
    .optional(),
  note: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  assignedUserId: z.string().max(40).nullable().optional(),
  nextFollowUpAt: z.string().datetime().nullable().optional(),
})

/** §27 — status tracking only. Nothing in this app sends anything to a lead. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireApiAuth()
    const { id } = await params

    const business = await prisma.business.findFirst({
      where: { id, workspaceId: auth.workspaceId },
      select: { id: true },
    })
    if (!business) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = schema.parse(await req.json())

    const status = await prisma.outreachStatus.upsert({
      where: { businessId: id },
      create: {
        businessId: id,
        stage: body.stage ?? 'NOT_CONTACTED',
        assignedUserId: body.assignedUserId ?? null,
        nextFollowUpAt: body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : null,
        lastContactAt: contactedNow(body.stage) ? new Date() : null,
      },
      update: {
        ...(body.stage ? { stage: body.stage } : {}),
        ...(body.assignedUserId !== undefined
          ? { assignedUserId: body.assignedUserId }
          : {}),
        ...(body.nextFollowUpAt !== undefined
          ? { nextFollowUpAt: body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : null }
          : {}),
        ...(contactedNow(body.stage) ? { lastContactAt: new Date() } : {}),
      },
    })

    if (body.note?.trim()) {
      await prisma.outreachNote.create({
        data: { statusId: status.id, body: body.note.trim(), authorId: auth.userId },
      })
    }

    if (body.tags) {
      await prisma.business.update({
        where: { id },
        data: { tags: Array.from(new Set(body.tags.map((t) => t.trim()).filter(Boolean))) },
      })
    }

    await prisma.auditLog.create({
      data: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        action: 'outreach.update',
        target: id,
        meta: { stage: body.stage ?? null, tagged: Boolean(body.tags) },
      },
    })

    return NextResponse.json({ ok: true, stage: status.stage })
  } catch (err) {
    return errorResponse(err)
  }
}

function contactedNow(stage?: string): boolean {
  return stage === 'CONTACTED' || stage === 'FOLLOW_UP' || stage === 'PROPOSAL_SENT'
}
