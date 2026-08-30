import 'server-only'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { prisma } from '@/server/db/client'
import { env } from '@/server/env'
import { compileQuery, compileOrderBy } from '@/server/filters/compile'
import { querySchema, type LeadQuery } from '@/server/filters/schema'
import {
  EXPORT_INCLUDE,
  cellValue,
  resolveColumns,
  type ExportColumn,
  type ExportRow,
} from './columns'
import type { JobContext } from '@/server/queue/types'

/**
 * Export execution (§9, §37).
 *
 * Server-side and streamed. The critical correctness property: the row set is
 * produced by `compileQuery` — the *same* compiler the table and the counts use.
 * "Export Current Filter" therefore cannot drift from what the user is looking at.
 *
 * Rows are read in keyset-paginated batches so a 100k-row export never
 * materialises in memory.
 */

const BATCH_SIZE = 500

export async function runExportJob(
  payload: { exportJobId: string; workspaceId: string },
  ctx: JobContext,
): Promise<void> {
  const job = await prisma.exportJob.findFirst({
    where: { id: payload.exportJobId, workspaceId: payload.workspaceId },
  })
  if (!job) throw new Error(`Export job ${payload.exportJobId} not found`)

  await prisma.exportJob.update({
    where: { id: job.id },
    data: { state: 'RUNNING' },
  })

  try {
    const columns = resolveColumns(job.columns)
    const where = buildWhere(job, payload.workspaceId)

    const dir = path.resolve(process.cwd(), env.storageDir, 'exports')
    await fs.mkdir(dir, { recursive: true })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safeTab = job.tab.replace(/[^a-z0-9-]/gi, '')
    const fileName = `lumen-${safeTab}-${stamp}.${job.format.toLowerCase()}`
    const filePath = path.join(dir, fileName)

    const rowCount =
      job.format === 'CSV'
        ? await writeCsv(filePath, where, columns, ctx)
        : await writeXlsx(filePath, where, columns, job.tab, ctx)

    const stat = await fs.stat(filePath)

    await prisma.exportJob.update({
      where: { id: job.id },
      data: {
        state: 'COMPLETED',
        rowCount,
        fileName,
        filePath,
        bytes: stat.size,
        completedAt: new Date(),
      },
    })

    ctx.log(`export complete: ${rowCount} rows → ${fileName}`)
  } catch (err) {
    await prisma.exportJob.update({
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

/**
 * Resolves the three export scopes (§9).
 *  - SELECTED: exactly the ids the user ticked
 *  - FILTER:   exactly the rows matching the active filter
 *  - ALL:      the whole tab, ignoring filters but never other workspaces
 */
function buildWhere(
  job: { scope: string; ids: string[]; filters: unknown; tab: string },
  workspaceId: string,
) {
  if (job.scope === 'SELECTED') {
    return { workspaceId, id: { in: job.ids } }
  }

  const parsed = querySchema.safeParse({
    ...(typeof job.filters === 'object' && job.filters !== null ? job.filters : {}),
    tab: job.tab,
  })

  const query: LeadQuery = parsed.success
    ? parsed.data
    : querySchema.parse({ tab: job.tab })

  if (job.scope === 'ALL') {
    // "Export All" still respects the tab the user was on — exporting SEO leads
    // should not silently include businesses with no SEO opportunity.
    return compileQuery(workspaceId, {
      ...query,
      filters: { logic: 'AND', conditions: [] },
      search: undefined,
      dateRange: undefined,
    })
  }

  return compileQuery(workspaceId, query)
}

/** Keyset pagination — stable and index-friendly regardless of result size. */
async function* streamRows(
  where: ReturnType<typeof compileQuery>,
  ctx: JobContext,
): AsyncGenerator<ExportRow[]> {
  let cursor: string | null = null

  for (;;) {
    const batch: ExportRow[] = await prisma.business.findMany({
      where,
      include: EXPORT_INCLUDE,
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    if (batch.length === 0) return
    yield batch
    await ctx.heartbeat()

    if (batch.length < BATCH_SIZE) return
    cursor = batch[batch.length - 1]!.id
  }
}

async function writeCsv(
  filePath: string,
  where: ReturnType<typeof compileQuery>,
  columns: ExportColumn[],
  ctx: JobContext,
): Promise<number> {
  const stream = createWriteStream(filePath, { encoding: 'utf8' })

  // BOM so Excel opens UTF-8 correctly rather than mangling accented names.
  stream.write('﻿')
  stream.write(`${columns.map((c) => csvCell(c.label)).join(',')}\n`)

  let count = 0
  for await (const batch of streamRows(where, ctx)) {
    let chunk = ''
    for (const row of batch) {
      chunk += `${columns.map((c) => csvCell(cellValue(c, row))).join(',')}\n`
      count++
    }
    if (!stream.write(chunk)) {
      await new Promise<void>((resolve) => stream.once('drain', resolve))
    }
  }

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })

  return count
}

function csvCell(value: string | number): string {
  const s = String(value)
  // Defuse spreadsheet formula injection: a cell starting with = + - @ is
  // executed by Excel/Sheets on open.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`
  return guarded
}

async function writeXlsx(
  filePath: string,
  where: ReturnType<typeof compileQuery>,
  columns: ExportColumn[],
  tab: string,
  ctx: JobContext,
): Promise<number> {
  const ExcelJS = await import('exceljs')

  // Streaming writer: rows are flushed to disk instead of held in memory.
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
  })
  workbook.creator = 'Lumen'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet(tabSheetName(tab), {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  sheet.columns = columns.map((c) => ({
    header: c.label,
    key: c.id,
    width: c.width,
  }))

  const header = sheet.getRow(1)
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F2937' },
  }
  header.alignment = { vertical: 'middle' }
  header.height = 22
  header.commit()

  let count = 0
  for await (const batch of streamRows(where, ctx)) {
    for (const row of batch) {
      const values: Record<string, string | number> = {}
      for (const c of columns) values[c.id] = cellValue(c, row)
      sheet.addRow(values).commit()
      count++
    }
  }

  // AutoFilter over the populated range so the file is usable immediately.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, count + 1), column: columns.length },
  }

  sheet.commit()
  await workbook.commit()
  return count
}

function tabSheetName(tab: string): string {
  const map: Record<string, string> = {
    all: 'All Businesses',
    'website-creation': 'Website Creation',
    redesign: 'Redesign',
    seo: 'SEO',
    speed: 'Speed',
    hot: 'Hot Leads',
    new: 'New Leads',
  }
  // Excel sheet names cap at 31 chars and forbid : \ / ? * [ ]
  return (map[tab] ?? tab).replace(/[:\\/?*[\]]/g, '').slice(0, 31)
}
