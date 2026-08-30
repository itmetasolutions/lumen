'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, FileSpreadsheet, FileText, CheckCircle2, AlertCircle } from 'lucide-react'
import { Badge, Button, Checkbox, Modal, Spinner } from '@/components/ui/primitives'
import { EXPORT_COLUMNS, DEFAULT_EXPORT_COLUMNS } from '@/server/export/columns'
import { formatNumber } from '@/lib/utils'
import type { LeadQuery, TabId } from '@/server/filters/schema'

/**
 * Export dialog (§9, §37).
 *
 * The scope choice is the important part. "Current filter" sends the exact same
 * `query` object the table is displaying, so the file cannot contain a different
 * set of rows than the screen. The dialog states the expected row count up front
 * and the server confirms it before the job is queued.
 */

type Scope = 'ALL' | 'FILTER' | 'SELECTED'

export function ExportDialog({
  open,
  onClose,
  tab,
  query,
  selectedIds,
  selectAllMatching,
  filteredCount,
  hasFilters,
}: {
  open: boolean
  onClose: () => void
  tab: TabId
  query: LeadQuery
  selectedIds: string[]
  selectAllMatching: boolean
  filteredCount: number
  hasFilters: boolean
}) {
  const [scope, setScope] = useState<Scope>('FILTER')
  const [format, setFormat] = useState<'XLSX' | 'CSV'>('XLSX')
  const [columns, setColumns] = useState<string[]>(DEFAULT_EXPORT_COLUMNS)
  const [state, setState] = useState<'idle' | 'queued' | 'ready' | 'error'>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [expected, setExpected] = useState<number | null>(null)

  const hasSelection = selectedIds.length > 0 || selectAllMatching

  useEffect(() => {
    if (!open) return
    setState('idle')
    setMessage(null)
    setJobId(null)
    setExpected(null)
    // Default to whichever scope reflects what the user is looking at.
    setScope(hasSelection ? 'SELECTED' : hasFilters ? 'FILTER' : 'ALL')
  }, [open, hasSelection, hasFilters])

  const groups = useMemo(() => {
    const map = new Map<string, typeof EXPORT_COLUMNS>()
    for (const c of EXPORT_COLUMNS) {
      const arr = map.get(c.group) ?? []
      arr.push(c)
      map.set(c.group, arr)
    }
    return Array.from(map.entries())
  }, [])

  const scopeCount =
    scope === 'SELECTED'
      ? selectAllMatching
        ? filteredCount
        : selectedIds.length
      : scope === 'FILTER'
        ? filteredCount
        : null

  async function start() {
    setState('queued')
    setMessage(null)

    try {
      // "Select all matching" means the filter *is* the selection, so we send
      // the query rather than a 10,000-item id list.
      const effectiveScope: Scope =
        scope === 'SELECTED' && selectAllMatching ? 'FILTER' : scope

      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          format,
          scope: effectiveScope,
          tab,
          query,
          ids: effectiveScope === 'SELECTED' ? selectedIds : [],
          columns,
        }),
      })
      const json = await res.json()

      if (!res.ok) {
        setState('error')
        setMessage(json.error ?? 'Export failed')
        return
      }

      setJobId(json.id)
      setExpected(json.expectedRows)
      void poll(json.id)
    } catch {
      setState('error')
      setMessage('Could not reach the server')
    }
  }

  async function poll(id: string) {
    // The worker generates the file; poll until it lands or clearly fails.
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, i < 10 ? 700 : 2000))
      try {
        const res = await fetch('/api/export')
        const json = await res.json()
        const job = json.jobs?.find((j: { id: string }) => j.id === id)
        if (!job) continue
        if (job.state === 'COMPLETED') {
          setState('ready')
          setMessage(`${formatNumber(job.rowCount)} businesses exported`)
          return
        }
        if (job.state === 'FAILED') {
          setState('error')
          setMessage(job.error ?? 'The export job failed')
          return
        }
      } catch {
        // Keep polling — a transient network blip is not a failed export.
      }
    }
    setState('error')
    setMessage('The export is taking longer than expected. Check the Exports page.')
  }

  function toggleColumn(id: string) {
    setColumns((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export businesses"
      description="Choose what to export and which fields to include. Files are generated server-side."
      width="max-w-2xl"
      footer={
        state === 'ready' && jobId ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <a href={`/api/export/${jobId}/download`} download>
              <Button variant="primary">
                <Download className="h-3.5 w-3.5" />
                Download file
              </Button>
            </a>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={start}
              loading={state === 'queued'}
              disabled={columns.length === 0 || state === 'queued'}
            >
              {state === 'queued' ? 'Generating…' : 'Generate export'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">
            What to export
          </div>
          <div className="space-y-1.5">
            <ScopeOption
              checked={scope === 'FILTER'}
              onSelect={() => setScope('FILTER')}
              title="Current filter"
              detail={
                hasFilters
                  ? `Exactly the ${formatNumber(filteredCount)} businesses matching your active filters and search.`
                  : `All ${formatNumber(filteredCount)} businesses in this tab (no filters are active).`
              }
              count={filteredCount}
            />
            <ScopeOption
              checked={scope === 'SELECTED'}
              onSelect={() => setScope('SELECTED')}
              disabled={!hasSelection}
              title="Selected rows"
              detail={
                hasSelection
                  ? selectAllMatching
                    ? 'Every row matching the current filter.'
                    : `The ${formatNumber(selectedIds.length)} rows you ticked.`
                  : 'Tick rows in the table to enable this.'
              }
              count={selectAllMatching ? filteredCount : selectedIds.length}
            />
            <ScopeOption
              checked={scope === 'ALL'}
              onSelect={() => setScope('ALL')}
              title="Everything in this tab"
              detail="Ignores filters, search and date range — but stays within this tab."
            />
          </div>
        </div>

        <div>
          <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">
            Format
          </div>
          <div className="flex gap-2">
            {(
              [
                ['XLSX', 'Excel workbook', FileSpreadsheet, 'Frozen header, filters, sized columns'],
                ['CSV', 'CSV file', FileText, 'UTF-8 with BOM, universally importable'],
              ] as const
            ).map(([value, label, Icon, hint]) => (
              <button
                key={value}
                onClick={() => setFormat(value)}
                className={`flex flex-1 items-start gap-2.5 rounded-lg border p-3 text-left transition-colors ${
                  format === value
                    ? 'border-accent bg-accent-soft'
                    : 'border-border hover:bg-surface-2'
                }`}
              >
                <Icon className={`mt-0.5 h-4 w-4 ${format === value ? 'text-accent' : 'text-subtle'}`} />
                <span>
                  <span className="block text-[13px] font-medium">{label}</span>
                  <span className="block text-2xs text-muted">{hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wide text-subtle">
              Fields ({columns.length})
            </span>
            <div className="flex gap-2 text-2xs">
              <button
                onClick={() => setColumns(EXPORT_COLUMNS.map((c) => c.id))}
                className="text-accent hover:underline"
              >
                Select all
              </button>
              <button
                onClick={() => setColumns(DEFAULT_EXPORT_COLUMNS)}
                className="text-muted hover:underline"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="max-h-52 overflow-y-auto rounded-lg border border-border p-2">
            {groups.map(([group, cols]) => (
              <div key={group} className="mb-2">
                <div className="px-1 py-1 text-2xs font-semibold text-subtle">{group}</div>
                <div className="grid grid-cols-2 gap-x-3">
                  {cols.map((c) => (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-surface-2"
                    >
                      <Checkbox
                        checked={columns.includes(c.id)}
                        onChange={() => toggleColumn(c.id)}
                      />
                      <span className="truncate">{c.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {scopeCount !== null && state === 'idle' && (
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[13px]">
            This will export{' '}
            <span className="tnum font-semibold">{formatNumber(scopeCount)}</span>{' '}
            businesses with{' '}
            <span className="tnum font-semibold">{columns.length}</span> fields.
          </div>
        )}

        {state === 'queued' && (
          <div className="flex items-center gap-2.5 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2.5 text-[13px] text-accent">
            <Spinner className="h-4 w-4" />
            Generating {expected !== null ? `${formatNumber(expected)} rows` : 'file'}…
            you can keep working.
          </div>
        )}

        {state === 'ready' && (
          <div className="flex items-center gap-2.5 rounded-lg border border-ok/25 bg-ok/10 px-3 py-2.5 text-[13px] text-ok">
            <CheckCircle2 className="h-4 w-4" />
            {message}
          </div>
        )}

        {state === 'error' && (
          <div className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {message}
          </div>
        )}

        <p className="text-2xs leading-5 text-subtle">
          Older demo records, if present, are still exported with a{' '}
          <Badge tone="demo">DEMO DATA</Badge> value in the Data Type column.
        </p>
      </div>
    </Modal>
  )
}

function ScopeOption({
  checked,
  onSelect,
  title,
  detail,
  count,
  disabled,
}: {
  checked: boolean
  onSelect: () => void
  title: string
  detail: string
  count?: number
  disabled?: boolean
}) {
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
        checked ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
          checked ? 'border-accent' : 'border-border-strong'
        }`}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          {title}
          {count !== undefined && count > 0 && (
            <span className="tnum rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-muted">
              {formatNumber(count)}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-2xs leading-4 text-muted">{detail}</span>
      </span>
    </button>
  )
}
