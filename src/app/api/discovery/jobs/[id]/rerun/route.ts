import { NextResponse } from 'next/server'
import { prisma } from '@/server/db/client'
import { requireApiAuth, requireRole } from '@/server/auth/guard'
import { getQueue } from '@/server/queue'
import { errorResponse } from '@/app/api/_lib/handler'

/**
 * §25 — re-run or duplicate a past search.
 *
 * Always creates a *new* job rather than mutating the old one: the previous
 * run's coverage report and results are history and must not be overwritten (§7).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireApiAuth()
    // Re-running a discovery spends provider quota — not an agent action.
    requireRole(auth, 'MEMBER')
    const { id } = await params

    const source = await prisma.discoveryJob.findFirst({
      where: { id, workspaceId: auth.workspaceId },
    })
    if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const url = new URL(req.url)
    const mode = url.searchParams.get('mode') === 'duplicate' ? 'duplicate' : 'rerun'

    const job = await prisma.discoveryJob.create({
      data: {
        workspaceId: auth.workspaceId,
        createdById: auth.userId,
        name:
          mode === 'duplicate'
            ? `${source.name} (copy)`
            : `${source.name} — re-run ${new Date().toLocaleDateString('en-GB')}`,
        country: source.country,
        countryCode: source.countryCode,
        region: source.region,
        city: source.city,
        area: source.area,
        postalCode: source.postalCode,
        radiusMeters: source.radiusMeters,
        centerLat: source.centerLat,
        centerLng: source.centerLng,
        industry: source.industry,
        categories: source.categories,
        keywords: source.keywords,
        exclusions: source.exclusions,
        expandTerms: source.expandTerms,
        providers: source.providers,
        depth: source.depth,
        state: 'PENDING',
      },
      select: { id: true, name: true },
    })

    await getQueue().enqueue(
      'discovery.run',
      { jobId: job.id, workspaceId: auth.workspaceId },
      { maxAttempts: 1 },
    )

    return NextResponse.json({ id: job.id, name: job.name })
  } catch (err) {
    return errorResponse(err)
  }
}
