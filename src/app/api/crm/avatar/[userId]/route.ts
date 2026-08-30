import { NextResponse } from 'next/server'
import { prisma } from '@/server/db/client'
import { requireApiAuth } from '@/server/auth/guard'
import { getStorage } from '@/server/storage'
import { errorResponse } from '@/app/api/_lib/handler'

/**
 * Serves a team member's avatar.
 *
 * The key comes from the database, never from the request, and the subject must
 * share a workspace with the caller — otherwise a user id would be enough to
 * read any avatar in the installation (§29).
 */

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const auth = await requireApiAuth()
    const { userId } = await params

    const member = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: auth.workspaceId } },
      select: { user: { select: { avatarPath: true, updatedAt: true } } },
    })
    const path = member?.user.avatarPath
    if (!path) return NextResponse.json({ error: 'No avatar' }, { status: 404 })

    const storage = await getStorage(auth.workspaceId)
    const buffer = await storage.get(path)
    const ext = path.split('.').pop()?.toLowerCase() ?? 'png'

    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'content-length': String(buffer.byteLength),
        // Short and revalidating: an avatar changes when someone chooses to
        // change it, and the new one should appear without a hard reload.
        'cache-control': 'private, max-age=60, must-revalidate',
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
