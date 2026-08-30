import { z } from 'zod'
import { prisma } from '@/server/db/client'
import { getQueue } from '@/server/queue'
import { getProvider } from '@/server/discovery/providers'
import { route, HttpError } from '@/app/api/_lib/handler'

const schema = z.object({
  name: z.string().max(140).optional(),
  country: z.string().max(80).optional(),
  region: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  area: z.string().max(120).optional(),
  postalCode: z.string().max(20).optional(),
  radiusMeters: z.number().int().min(250).max(200_000).optional(),

  industry: z.string().min(1).max(120),
  categories: z.array(z.string().max(80)).max(20).default([]),
  keywords: z.array(z.string().max(80)).max(20).default([]),
  exclusions: z.array(z.string().max(80)).max(20).default([]),
  expandTerms: z.boolean().default(true),

  providers: z.array(z.string().max(50)).min(1).max(10),
  depth: z.enum(['QUICK', 'STANDARD', 'DEEP']).default('STANDARD'),
})

export const POST = route({ schema, limit: 'expensive' }, async ({ auth, body }) => {
  // A location must be specified at *some* level — otherwise the geocoder has
  // nothing to resolve and we would silently search a default city.
  if (!body.country && !body.region && !body.city && !body.area && !body.postalCode) {
    throw new HttpError(400, 'Specify at least a country, region, city, area or postal code')
  }

  const unknown = body.providers.filter((id) => !getProvider(id))
  if (unknown.length > 0) {
    throw new HttpError(400, `Unknown discovery provider(s): ${unknown.join(', ')}`)
  }

  // A provider whose credentials are missing must not be silently swapped for
  // another source — the user chose it and needs to be told (§21).
  for (const id of body.providers) {
    const provider = getProvider(id)!
    const status = await provider.configured(auth.workspaceId)
    if (status.state !== 'CONNECTED') {
      throw new HttpError(
        400,
        `${provider.label} is not available. ${status.detail}`,
      )
    }
  }

  const locationLabel =
    [body.area, body.city, body.region, body.country].filter(Boolean).join(', ') ||
    body.postalCode ||
    'Unspecified area'

  const job = await prisma.discoveryJob.create({
    data: {
      workspaceId: auth.workspaceId,
      createdById: auth.userId,
      name: body.name?.trim() || `${body.industry} — ${locationLabel}`,
      country: body.country ?? null,
      region: body.region ?? null,
      city: body.city ?? null,
      area: body.area ?? null,
      postalCode: body.postalCode ?? null,
      radiusMeters: body.radiusMeters ?? null,
      industry: body.industry,
      categories: body.categories,
      keywords: body.keywords,
      exclusions: body.exclusions,
      expandTerms: body.expandTerms,
      providers: body.providers,
      depth: body.depth,
      state: 'PENDING',
    },
    select: { id: true, name: true },
  })

  await getQueue().enqueue(
    'discovery.run',
    { jobId: job.id, workspaceId: auth.workspaceId },
    { maxAttempts: 1 },
  )

  return { id: job.id, name: job.name }
})
