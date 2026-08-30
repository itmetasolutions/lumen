import { z } from 'zod'
import { changeOwnPassword, updateOwnProfile } from '@/server/crm/team'
import { getStorage } from '@/server/storage'
import { prisma } from '@/server/db/client'
import { route, HttpError } from '@/app/api/_lib/handler'

/**
 * Self-service profile.
 *
 * The one surface every role shares, and the only thing an agent may change
 * about their own account: display name, job title, contact number, avatar and
 * password. Role, workspace and lead assignments are deliberately absent — an
 * account cannot promote itself.
 */

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update'),
    name: z.string().max(120).optional(),
    jobTitle: z.string().max(120).nullish(),
    phone: z.string().max(40).nullish(),
  }),
  z.object({
    action: z.literal('password'),
    current: z.string().min(1).max(200),
    next: z.string().min(1).max(200),
  }),
])

export const GET = route({ limit: 'read' }, async ({ auth }) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.userId },
    select: {
      id: true, email: true, name: true, jobTitle: true, phone: true,
      avatarPath: true, mustChangePassword: true, lastLoginAt: true,
    },
  })
  return { profile: user, role: auth.role, workspaceName: auth.workspaceName }
})

export const POST = route({ schema, limit: 'write' }, async ({ auth, body }) => {
  if (body.action === 'password') {
    await changeOwnPassword({ userId: auth.userId, current: body.current, next: body.next })
    return { ok: true }
  }

  await updateOwnProfile({
    userId: auth.userId,
    name: body.name,
    jobTitle: body.jobTitle,
    phone: body.phone,
  })
  return { ok: true }
})

/** Avatar upload — multipart, so it bypasses the JSON body reader. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const ALLOWED = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
])

export const PUT = route({ limit: 'write' }, async ({ auth, req }) => {
  const form = await req.formData().catch(() => null)
  const file = form?.get('avatar')
  if (!(file instanceof File)) throw new HttpError(400, 'No image was uploaded')

  const ext = ALLOWED.get(file.type)
  // Trust the declared type only after checking it against a fixed list; an
  // unrecognised type is rejected rather than stored under a guessed extension.
  if (!ext) throw new HttpError(400, 'Upload a PNG, JPEG or WebP image')
  if (file.size > MAX_AVATAR_BYTES) throw new HttpError(400, 'Images must be under 2 MB')

  const storage = await getStorage()
  const key = `avatars/${auth.userId}.${ext}`
  await storage.put(key, Buffer.from(await file.arrayBuffer()), file.type)

  const previous = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { avatarPath: true },
  })
  await updateOwnProfile({ userId: auth.userId, avatarPath: key })

  // Replacing a PNG with a JPEG leaves the old key orphaned otherwise.
  if (previous?.avatarPath && previous.avatarPath !== key) {
    await storage.delete(previous.avatarPath).catch(() => {})
  }

  return { avatarPath: key }
})
