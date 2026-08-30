import 'server-only'
import { prisma } from '@/server/db/client'
import { env } from '@/server/env'
import { getQueue } from '@/server/queue'
import { recordUsage } from '@/server/usage/record'
import { resolveAndUpsert } from '@/server/resolution/resolve'
import { getProvider } from './providers'
import { normalizeRawBusiness } from './normalize'
import { expandTerms, isExcluded } from './expansion'
import { defaultRadiusFor, planTiles, planTilesForBBox } from './tiling'
import { geocode } from './geocode'
import type { DiscoveryQuery, GeoCell, LocationInput, ProviderRunContext } from './types'
import type { JobContext } from '@/server/queue/types'

/**
 * The discovery pipeline (§2, §4).
 *
 * Failure policy throughout (§31): one provider, one cell or one record failing
 * never aborts the job. Errors are counted, recorded against the SearchQuery row
 * that produced them, and surfaced in the coverage report. A job that hit some
 * errors but produced results finishes PARTIAL, not FAILED.
 */

export async function runDiscovery(
  payload: { jobId: string; workspaceId: string },
  ctx: JobContext,
): Promise<void> {
  const { jobId, workspaceId } = payload

  const job = await prisma.discoveryJob.findFirst({
    where: { id: jobId, workspaceId },
  })
  if (!job) throw new Error(`Discovery job ${jobId} not found in workspace`)

  const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId } })
  const maxBusinesses =
    settings?.maxBusinessesPerDiscovery ?? env.maxBusinessesPerDiscovery

  await prisma.discoveryJob.update({
    where: { id: jobId },
    data: { state: 'RUNNING', startedAt: new Date(), progressStage: 'Planning' },
  })
  await emit(jobId, 'plan', 'Planning search coverage')

  // ── 1. Resolve the location to coordinates ────────────────────────────────
  let centerLat = job.centerLat
  let centerLng = job.centerLng
  let radius = job.radiusMeters
  let bbox =
    job.bboxMinLat !== null &&
    job.bboxMinLng !== null &&
    job.bboxMaxLat !== null &&
    job.bboxMaxLng !== null
      ? {
          minLat: job.bboxMinLat,
          minLng: job.bboxMinLng,
          maxLat: job.bboxMaxLat,
          maxLng: job.bboxMaxLng,
        }
      : null

  let countryCode = job.countryCode

  if (centerLat === null || centerLng === null) {
    const geo = await geocode(
      {
        country: job.country,
        region: job.region,
        city: job.city,
        area: job.area,
        postalCode: job.postalCode,
      },
      workspaceId,
    )
    if (!geo) {
      await failJob(jobId, 'Could not resolve that location to coordinates. Try adding a city or country.')
      return
    }
    centerLat = geo.lat
    centerLng = geo.lng
    countryCode = countryCode ?? geo.countryCode
    if (!bbox) bbox = geo.bbox
    if (!radius) radius = defaultRadiusFor(geo.scope)
    await emit(jobId, 'plan', `Location resolved: ${geo.displayName}`, {
      provider: geo.provider,
      lat: geo.lat,
      lng: geo.lng,
    })
  }

  radius = radius ?? defaultRadiusFor('city')

  // ── 2. Tile the geography ─────────────────────────────────────────────────
  const tiling = bbox
    ? planTilesForBBox(bbox)
    : planTiles({ centerLat, centerLng, radiusMeters: radius })

  const cells = tiling.cells

  // ── 3. Expand the industry into search terms ──────────────────────────────
  const terms = expandTerms({
    industry: job.industry,
    categories: job.categories,
    keywords: job.keywords,
    enabled: job.expandTerms,
  })

  const providers = job.providers
    .map((id) => getProvider(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))

  if (providers.length === 0) {
    await failJob(jobId, 'No valid discovery providers were selected.')
    return
  }

  const plannedQueries = providers.length * cells.length * terms.length

  await prisma.discoveryJob.update({
    where: { id: jobId },
    data: {
      centerLat,
      centerLng,
      radiusMeters: radius,
      countryCode,
      cellsPlanned: cells.length,
      sourcesSearched: providers.map((p) => p.id),
      progressStage: 'Discovering businesses',
      progressPercent: 2,
    },
  })

  await emit(
    jobId,
    'plan',
    `Searching ${terms.length} term(s) across ${cells.length} geographic cell(s) on ${providers.length} source(s) — ${plannedQueries} queries`,
    { tiling: tiling.summary, terms: terms.map((t) => t.term) },
  )

  // ── 4. Execute ────────────────────────────────────────────────────────────
  const location: LocationInput = {
    country: job.country,
    countryCode,
    region: job.region,
    city: job.city,
    area: job.area,
    postalCode: job.postalCode,
    radiusMeters: radius,
    centerLat,
    centerLng,
  }

  let candidatesFound = 0
  let duplicatesMerged = 0
  let newBusinesses = 0
  let queriesExecuted = 0
  let errorCount = 0
  const touchedBusinessIds = new Set<string>()
  const cellsTouched = new Set<number>()

  outer: for (const provider of providers) {
    for (const cell of cells) {
      for (const term of terms) {
        if (await ctx.isCancelled()) break outer
        if (touchedBusinessIds.size >= maxBusinesses) {
          await emit(
            jobId,
            'discover',
            `Reached the configured cap of ${maxBusinesses} businesses; stopping discovery early.`,
            {},
            'warn',
          )
          break outer
        }

        const query: DiscoveryQuery = {
          term: term.term,
          isExpanded: term.isExpanded,
          originTerm: term.originTerm,
          cell,
          location,
          exclusions: job.exclusions,
          limit: Math.min(60, maxBusinesses - touchedBusinessIds.size),
        }

        const sq = await prisma.searchQuery.create({
          data: {
            jobId,
            provider: provider.id,
            term: term.term,
            isExpanded: term.isExpanded,
            originTerm: term.originTerm,
            cellIndex: cell.index,
            cellLat: cell.lat,
            cellLng: cell.lng,
            cellRadius: cell.radiusMeters,
            status: 'RUNNING',
          },
          select: { id: true },
        })

        const started = Date.now()
        try {
          const runCtx: ProviderRunContext = {
            workspaceId,
            jobId,
            recordUsage: (operation, units) =>
              recordUsage({ workspaceId, provider: provider.id, operation, units }),
            log: ctx.log,
          }

          const results = await provider.search(query, runCtx)
          queriesExecuted++
          cellsTouched.add(cell.index)
          candidatesFound += results.length

          let kept = 0
          for (const raw of results) {
            if (isExcluded(raw, job.exclusions)) continue

            const draft = normalizeRawBusiness(raw, {
              provider: provider.id,
              isDemo: provider.isDemo,
              industry: job.industry,
            })
            if (!draft) continue

            try {
              const outcome = await resolveAndUpsert(draft, { workspaceId, jobId })
              touchedBusinessIds.add(outcome.businessId)
              if (outcome.created) newBusinesses++
              else duplicatesMerged++
              kept++
            } catch (err) {
              // A single malformed record must not lose the other 19.
              errorCount++
              ctx.log(`resolve failed for "${draft.name}"`, err)
            }
          }

          await prisma.searchQuery.update({
            where: { id: sq.id },
            data: {
              status: 'OK',
              resultCount: kept,
              durationMs: Date.now() - started,
              executedAt: new Date(),
            },
          })
        } catch (err) {
          errorCount++
          const message = err instanceof Error ? err.message : String(err)
          await prisma.searchQuery.update({
            where: { id: sq.id },
            data: {
              status: 'FAILED',
              error: message.slice(0, 1000),
              durationMs: Date.now() - started,
              executedAt: new Date(),
            },
          })
          await emit(
            jobId,
            'discover',
            `${provider.label}: "${term.term}" failed — ${message}`,
            {},
            'warn',
          )
        }

        // Progress is reported from work actually done, not a guess.
        const done = queriesExecuted + errorCount
        await prisma.discoveryJob.update({
          where: { id: jobId },
          data: {
            queriesExecuted,
            candidatesFound,
            uniqueBusinesses: touchedBusinessIds.size,
            duplicatesMerged,
            newBusinesses,
            errorCount,
            cellsSearched: cellsTouched.size,
            progressPercent: Math.min(
              70,
              2 + Math.round((done / Math.max(1, plannedQueries)) * 68),
            ),
          },
        })

        await ctx.heartbeat()
      }
    }
  }

  await emit(
    jobId,
    'dedupe',
    `${candidatesFound} candidate records resolved to ${touchedBusinessIds.size} unique businesses (${duplicatesMerged} merged into existing records)`,
  )

  // ── 5. Fan out audits ─────────────────────────────────────────────────────
  await prisma.discoveryJob.update({
    where: { id: jobId },
    data: { progressStage: 'Queueing website audits', progressPercent: 75 },
  })

  const queue = getQueue()
  const ids = Array.from(touchedBusinessIds)

  await prisma.business.updateMany({
    where: { id: { in: ids }, websiteStatus: { not: 'NONE' } },
    data: { auditStatus: 'QUEUED' },
  })

  let queued = 0
  for (const businessId of ids) {
    try {
      await queue.enqueue('audit.site', {
        businessId,
        workspaceId,
        depth: job.depth,
        trigger: 'discovery',
      })
      queued++
    } catch (err) {
      errorCount++
      ctx.log(`failed to enqueue audit for ${businessId}`, err)
    }
  }

  await emit(jobId, 'audit', `${queued} website audit(s) queued`)

  // ── 6. Finalise ───────────────────────────────────────────────────────────
  const finalState =
    touchedBusinessIds.size === 0 && errorCount > 0
      ? 'FAILED'
      : errorCount > 0
        ? 'PARTIAL'
        : 'COMPLETED'

  await prisma.discoveryJob.update({
    where: { id: jobId },
    data: {
      state: finalState,
      completedAt: new Date(),
      progressStage: finalState === 'FAILED' ? 'Failed' : 'Completed',
      progressPercent: 100,
      queriesExecuted,
      candidatesFound,
      uniqueBusinesses: touchedBusinessIds.size,
      duplicatesMerged,
      newBusinesses,
      errorCount,
      cellsSearched: cellsTouched.size,
      error:
        finalState === 'FAILED'
          ? 'Every provider query failed. Check Settings → Integrations.'
          : null,
    },
  })

  await emit(
    jobId,
    'done',
    `Discovery ${finalState.toLowerCase()}: ${newBusinesses} new, ${duplicatesMerged} merged, ${errorCount} error(s)`,
  )
}

async function emit(
  jobId: string,
  stage: string,
  message: string,
  data?: unknown,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  await prisma.jobEvent
    .create({
      data: {
        jobId,
        stage,
        level,
        message,
        data: data === undefined ? undefined : (data as object),
      },
    })
    .catch(() => {
      // Logging must never be the reason a job dies.
    })
}

async function failJob(jobId: string, reason: string): Promise<void> {
  await prisma.discoveryJob.update({
    where: { id: jobId },
    data: {
      state: 'FAILED',
      error: reason,
      completedAt: new Date(),
      progressStage: 'Failed',
      progressPercent: 100,
    },
  })
  await emit(jobId, 'error', reason, undefined, 'error')
}
