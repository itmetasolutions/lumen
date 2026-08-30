import { NextResponse } from 'next/server'
import { prisma } from '@/server/db/client'
import { requireApiAuth } from '@/server/auth/guard'
import { getStorage } from '@/server/storage'
import { errorResponse } from '@/app/api/_lib/handler'

/**
 * Serves an audit screenshot.
 *
 * The storage key is looked up from the database by id and the owning
 * workspace is verified — the client never supplies a path, so there is no
 * traversal surface here (§29).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireApiAuth()
    const { id } = await params

    const shot = await prisma.screenshot.findFirst({
      where: {
        id,
        uxResult: { audit: { business: { workspaceId: auth.workspaceId } } },
      },
      select: { path: true, viewport: true },
    })
    if (!shot) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const storage = await getStorage(auth.workspaceId)
    const buffer = await storage.get(shot.path)

    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(buffer.byteLength),
        // Audit screenshots are immutable once written.
        'cache-control': 'private, max-age=86400, immutable',
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
