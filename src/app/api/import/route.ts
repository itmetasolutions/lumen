import { NextResponse } from 'next/server'
import { prisma } from '@/server/db/client'
import { requireApiAuth, requireRole, HttpError } from '@/server/auth/guard'
import { getStorage } from '@/server/storage'
import { getQueue } from '@/server/queue'
import { parseCsv, parseXlsx } from '@/server/import/parse'
import { mapHeaders } from '@/server/import/map-rows'
import { errorResponse } from '@/app/api/_lib/handler'
import { rateLimit, clientKey, LIMITS } from '@/server/http/rate-limit'

/**
 * Lead import upload.
 *
 * Accepts a CSV or XLSX exported from Lumen (or any file with a recognisable
 * business-name column). The file is parsed once here purely to validate it and
 * report the column mapping back to the user; the actual import runs on the
 * worker, because resolving thousands of rows against existing leads is far too
 * slow for a request.
 */

const MAX_BYTES = 25 * 1024 * 1024

export async function POST(req: Request) {
  try {
    const auth = await requireApiAuth()
    requireRole(auth, 'MEMBER')

    const rl = rateLimit(clientKey(req, 'import'), LIMITS.expensive.limit, LIMITS.expensive.windowMs)
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many imports. Try again shortly.' },
        { status: 429, headers: { 'retry-after': String(rl.retryAfterSeconds) } },
      )
    }

    const form = await req.formData()
    const file = form.get('file')

    if (!(file instanceof File)) {
      throw new HttpError(400, 'No file was uploaded')
    }
    if (file.size === 0) {
      throw new HttpError(400, 'The uploaded file is empty')
    }
    if (file.size > MAX_BYTES) {
      throw new HttpError(400, `File is too large (max ${MAX_BYTES / 1024 / 1024} MB)`)
    }

    const lower = file.name.toLowerCase()
    const format = lower.endsWith('.xlsx') ? 'XLSX' : lower.endsWith('.csv') ? 'CSV' : null
    if (!format) {
      throw new HttpError(400, 'Only .csv and .xlsx files can be imported')
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    // Validate before accepting: a file with no name column can never import,
    // and saying so now is far better than a failed job five minutes later.
    const parsed =
      format === 'XLSX' ? await parseXlsx(buffer) : parseCsv(buffer.toString('utf8'))

    if (parsed.rows.length === 0) {
      throw new HttpError(400, 'The file has no data rows')
    }

    const mapping = mapHeaders(parsed.headers)
    if (mapping.missingRequired.length > 0) {
      throw new HttpError(
        400,
        `No business name column found. Columns in this file: ${parsed.headers.slice(0, 15).join(', ')}`,
      )
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const key = `imports/${auth.workspaceId}/${stamp}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`

    const storage = await getStorage()
    const stored = await storage.put(
      key,
      buffer,
      format === 'XLSX'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv',
    )

    const job = await prisma.importJob.create({
      data: {
        workspaceId: auth.workspaceId,
        createdById: auth.userId,
        fileName: file.name,
        filePath: stored.key,
        format,
        bytes: stored.bytes,
        totalRows: parsed.rows.length,
        state: 'PENDING',
      },
      select: { id: true },
    })

    await getQueue().enqueue('import.run', {
      importJobId: job.id,
      workspaceId: auth.workspaceId,
    })

    await prisma.auditLog.create({
      data: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        action: 'leads.import',
        target: job.id,
        meta: { fileName: file.name, rows: parsed.rows.length },
      },
    })

    return NextResponse.json({
      id: job.id,
      rows: parsed.rows.length,
      mapped: Object.keys(mapping.resolved),
      ignored: mapping.ignored,
    })
  } catch (err) {
    return errorResponse(err)
  }
}

/** Recent imports, for the progress panel and history. */
export async function GET() {
  try {
    const auth = await requireApiAuth()
    const jobs = await prisma.importJob.findMany({
      where: { workspaceId: auth.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, fileName: true, format: true, state: true,
        totalRows: true, processedRows: true, createdCount: true,
        mergedCount: true, skippedCount: true, errorCount: true,
        errors: true, error: true, createdAt: true, completedAt: true,
      },
    })
    return NextResponse.json({ jobs })
  } catch (err) {
    return errorResponse(err)
  }
}
