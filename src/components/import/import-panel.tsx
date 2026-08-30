'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, CheckCircle2, AlertCircle, FileSpreadsheet } from 'lucide-react'
import { Badge, Button, Modal, Spinner } from '@/components/ui/primitives'
import { formatNumber } from '@/lib/utils'

/**
 * Import leads exported from another Lumen workspace.
 *
 * The upload validates and reports the column mapping immediately, then polls
 * the background job. Showing which columns were matched — and which were
 * deliberately ignored — is the difference between "it worked" and knowing
 * whether it actually brought in what you expected.
 */

interface ImportJob {
  id: string
  fileName: string
  state: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED'
  totalRows: number
  processedRows: number
  createdCount: number
  mergedCount: number
  skippedCount: number
  errorCount: number
  errors: Array<{ row: number; reason: string }>
  error: string | null
}

interface UploadResult {
  id: string
  rows: number
  mapped: string[]
  ignored: Array<{ header: string; reason: string }>
}

const TERMINAL = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'])

export function ImportPanel() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [upload, setUpload] = useState<UploadResult | null>(null)
  const [job, setJob] = useState<ImportJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const polling = useRef(false)

  async function onFile(file: File) {
    setUploading(true)
    setError(null)
    setUpload(null)
    setJob(null)

    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch('/api/import', { method: 'POST', body })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Import failed')
        return
      }
      setUpload(json as UploadResult)
      void poll(json.id)
    } catch {
      setError('Could not reach the server')
    } finally {
      setUploading(false)
    }
  }

  async function poll(id: string) {
    if (polling.current) return
    polling.current = true
    try {
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, i < 10 ? 800 : 2500))
        const res = await fetch('/api/import')
        if (!res.ok) continue
        const json = await res.json()
        const found = (json.jobs as ImportJob[]).find((j) => j.id === id)
        if (!found) continue
        setJob(found)
        if (TERMINAL.has(found.state)) {
          router.refresh()
          return
        }
      }
    } finally {
      polling.current = false
    }
  }

  useEffect(() => {
    if (!open) {
      setUpload(null)
      setJob(null)
      setError(null)
    }
  }, [open])

  const done = job && TERMINAL.has(job.state)

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Upload className="h-3.5 w-3.5" />
        Import leads
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import leads"
        description="Bring in a CSV or XLSX exported from another Lumen workspace."
        width="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {done ? 'Done' : 'Close'}
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface-2 px-3.5 py-3 text-[13px] leading-5 text-muted">
            Rows are matched against your existing leads on name, phone, domain
            and location, so importing a file that overlaps this workspace{' '}
            <strong className="text-fg">merges rather than duplicating</strong>.
            <div className="mt-2 text-2xs">
              Audit results — SEO health, lead score, opportunity flags — are not
              imported. They describe an audit that ran somewhere else. Run an
              audit here and this workspace will compute its own.
            </div>
          </div>

          {!upload && (
            <div>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void onFile(f)
                }}
              />
              <button
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border-strong px-6 py-10 transition-colors hover:border-accent hover:bg-accent-soft/40 disabled:opacity-60"
              >
                {uploading ? (
                  <Spinner className="h-5 w-5 text-accent" />
                ) : (
                  <FileSpreadsheet className="h-6 w-6 text-subtle" />
                )}
                <span className="text-[13px] font-medium">
                  {uploading ? 'Reading file…' : 'Choose a .csv or .xlsx file'}
                </span>
                <span className="text-2xs text-subtle">Up to 25 MB</span>
              </button>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}

          {upload && (
            <div className="space-y-3">
              <div className="rounded-lg border border-border px-3.5 py-3">
                <div className="text-[13px] font-medium">
                  {formatNumber(upload.rows)} rows · {upload.mapped.length} columns matched
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {upload.mapped.map((m) => (
                    <Badge key={m} tone="ok">
                      {m}
                    </Badge>
                  ))}
                </div>
                {upload.ignored.length > 0 && (
                  <details className="mt-2.5">
                    <summary className="cursor-pointer text-2xs text-subtle">
                      {upload.ignored.length} column(s) ignored
                    </summary>
                    <ul className="mt-1.5 space-y-1">
                      {upload.ignored.map((c) => (
                        <li key={c.header} className="text-2xs text-muted">
                          <span className="font-medium">{c.header}</span> — {c.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {job && (
                <div
                  className={
                    job.state === 'FAILED'
                      ? 'rounded-lg border border-danger/25 bg-danger/10 px-3.5 py-3 text-[13px] text-danger'
                      : done
                        ? 'rounded-lg border border-ok/25 bg-ok/10 px-3.5 py-3 text-[13px] text-ok'
                        : 'rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-3 text-[13px] text-accent'
                  }
                >
                  <div className="flex items-center gap-2 font-medium">
                    {done ? (
                      job.state === 'FAILED' ? (
                        <AlertCircle className="h-4 w-4" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )
                    ) : (
                      <Spinner className="h-4 w-4" />
                    )}
                    {job.state === 'FAILED'
                      ? (job.error ?? 'Import failed')
                      : done
                        ? 'Import complete'
                        : `Importing… ${formatNumber(job.processedRows)} / ${formatNumber(job.totalRows)}`}
                  </div>

                  {job.state !== 'FAILED' && (
                    <div className="mt-1.5 text-2xs">
                      {formatNumber(job.createdCount)} new ·{' '}
                      {formatNumber(job.mergedCount)} merged into existing ·{' '}
                      {formatNumber(job.skippedCount)} skipped
                    </div>
                  )}
                </div>
              )}

              {done && job && job.errors?.length > 0 && (
                <details className="rounded-lg border border-border px-3.5 py-2.5">
                  <summary className="cursor-pointer text-[13px] font-medium">
                    {formatNumber(job.errors.length)} row(s) could not be imported
                  </summary>
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                    {job.errors.map((e, i) => (
                      <li key={i} className="text-2xs text-muted">
                        Row {e.row}: {e.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
