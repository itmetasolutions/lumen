import 'server-only'
import { prisma } from '@/server/db/client'
import { getStorage } from '@/server/storage'
import { normalizeRawBusiness } from '@/server/discovery/normalize'
import { resolveAndUpsert } from '@/server/resolution/resolve'
import { parseCsv, parseXlsx } from './parse'
import { mapHeaders, mapRow } from './map-rows'
import type { JobContext } from '@/server/queue/types'
import type { ContactStage } from '@prisma/client'

/**
 * Import runner.
 *
 * Imported rows go through exactly the same path as discovered ones —
 * normalisation, then entity resolution — so importing a file that overlaps the
 * target workspace merges into the existing records instead of creating a second
 * copy of every business. That is the whole reason this is not a bulk insert.
 */

const IMPORT_PROVIDER = 'csv-import'
const MAX_RECORDED_ERRORS = 50
const PROGRESS_EVERY = 25

const STAGE_VALUES: ContactStage[] = [
  'NOT_CONTACTED', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'QUALIFIED',
  'PROPOSAL_SENT', 'WON', 'LOST', 'NOT_INTERESTED', 'DO_NOT_CONTACT',
]

/** Accepts both the enum value and the human label the exporter writes. */
function parseStage(raw: string | null): ContactStage | null {
  if (!raw) return null
  const key = raw.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return STAGE_VALUES.find((s) => s === key) ?? null
}

export async function runImport(
  payload: { importJobId: string; workspaceId: string },
  ctx: JobContext,
): Promise<void> {
  const job = await prisma.importJob.findFirst({
    where: { id: payload.importJobId, workspaceId: payload.workspaceId },
  })
  if (!job) throw new Error(`Import job ${payload.importJobId} not found`)

  await prisma.importJob.update({
    where: { id: job.id },
    data: { state: 'RUNNING' },
  })

  try {
    const storage = await getStorage()
    const buffer = await storage.get(job.filePath)

    const parsed =
      job.format === 'XLSX'
        ? await parseXlsx(buffer)
        : parseCsv(buffer.toString('utf8'))

    const mapping = mapHeaders(parsed.headers)

    if (mapping.missingRequired.length > 0) {
      throw new Error(
        `The file has no business name column. Looked for: ${mapping.missingRequired.join(', ')}. Found: ${parsed.headers.slice(0, 12).join(', ')}`,
      )
    }

    const errors: Array<{ row: number; reason: string }> = []
    let created = 0
    let merged = 0
    let skipped = 0
    let processed = 0

    await prisma.importJob.update({
      where: { id: job.id },
      data: { totalRows: parsed.rows.length },
    })

    ctx.log(`importing ${parsed.rows.length} rows`, mapping.resolved)

    for (const [index, row] of parsed.rows.entries()) {
      processed++

      try {
        const mapped = mapRow(row, mapping)
        if (!mapped) {
          skipped++
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push({ row: index + 2, reason: 'No business name' })
          }
          continue
        }

        const draft = normalizeRawBusiness(mapped.business, {
          provider: IMPORT_PROVIDER,
          // A row marked DEMO in the source file stays marked here — the label
          // must survive the round trip or demo data silently becomes live.
          isDemo: mapped.isDemo,
          industry: row[mapping.resolved.industry ?? ''] ?? '',
        })

        if (!draft) {
          skipped++
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push({ row: index + 2, reason: 'Row could not be normalised' })
          }
          continue
        }

        const outcome = await resolveAndUpsert(draft, {
          workspaceId: payload.workspaceId,
          jobId: null,
        })

        if (outcome.created) created++
        else merged++

        // Workflow state travels with the lead when present.
        if (mapped.tags.length > 0) {
          const current = await prisma.business.findUnique({
            where: { id: outcome.businessId },
            select: { tags: true },
          })
          const union = [...new Set([...(current?.tags ?? []), ...mapped.tags])]
          await prisma.business.update({
            where: { id: outcome.businessId },
            data: { tags: union },
          })
        }

        const stage = parseStage(mapped.outreachStage)
        if (stage && stage !== 'NOT_CONTACTED') {
          await prisma.outreachStatus.upsert({
            where: { businessId: outcome.businessId },
            create: { businessId: outcome.businessId, stage },
            update: { stage },
          })
        }
      } catch (err) {
        skipped++
        if (errors.length < MAX_RECORDED_ERRORS) {
          errors.push({ row: index + 2, reason: (err as Error).message.slice(0, 200) })
        }
      }

      if (processed % PROGRESS_EVERY === 0) {
        await prisma.importJob.update({
          where: { id: job.id },
          data: {
            processedRows: processed,
            createdCount: created,
            mergedCount: merged,
            skippedCount: skipped,
            errorCount: errors.length,
          },
        })
        await ctx.heartbeat()
      }
    }

    const state = skipped === parsed.rows.length && parsed.rows.length > 0
      ? 'FAILED'
      : skipped > 0
        ? 'PARTIAL'
        : 'COMPLETED'

    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        state,
        processedRows: processed,
        createdCount: created,
        mergedCount: merged,
        skippedCount: skipped,
        errorCount: errors.length,
        errors: errors as unknown as object,
        completedAt: new Date(),
        error: state === 'FAILED' ? 'No row in the file could be imported.' : null,
      },
    })

    ctx.log(`import ${state}: ${created} created, ${merged} merged, ${skipped} skipped`)
  } catch (err) {
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        state: 'FAILED',
        error: (err as Error).message.slice(0, 1000),
        completedAt: new Date(),
      },
    })
    throw err
  }
}
