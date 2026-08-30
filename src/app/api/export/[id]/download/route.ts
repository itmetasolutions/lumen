import { NextResponse } from 'next/server'
import fs from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { prisma } from '@/server/db/client'
import { requireApiAuth } from '@/server/auth/guard'
import { errorResponse } from '@/app/api/_lib/handler'

/**
 * Serves a generated export.
 *
 * §29: exports are never published at a guessable public path. The file is read
 * server-side only after the caller's membership of the owning workspace has
 * been re-checked on this request.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireApiAuth()
    const { id } = await params

    const job = await prisma.exportJob.findFirst({
      where: { id, workspaceId: auth.workspaceId },
    })
    if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (job.state !== 'COMPLETED' || !job.filePath) {
      return NextResponse.json(
        { error: `Export is ${job.state.toLowerCase()}`, state: job.state },
        { status: 409 },
      )
    }

    try {
      await stat(job.filePath)
    } catch {
      return NextResponse.json(
        { error: 'The generated file is no longer available. Re-run the export.' },
        { status: 410 },
      )
    }

    const stream = Readable.toWeb(
      fs.createReadStream(job.filePath),
    ) as unknown as ReadableStream

    const contentType =
      job.format === 'CSV'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

    return new Response(stream, {
      headers: {
        'content-type': contentType,
        'content-disposition': `attachment; filename="${job.fileName ?? 'export'}"`,
        'content-length': String(job.bytes ?? 0),
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
