'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Search, SlidersHorizontal, Columns3, Download, Bookmark, RotateCw,
  ChevronLeft, ChevronRight, ArrowUp, ArrowDown, Database, X, Check, ClipboardCheck,
  Trash2, Sparkles,
} from 'lucide-react'
import {
  Badge, Button, Checkbox, EmptyState, Input, Select, TableSkeleton, Tooltip,
} from '@/components/ui/primitives'
import { FilterBuilder, countConditions } from '@/components/filters/filter-builder'
import { ExportDialog } from './export-dialog'
import { SaveViewDialog } from './save-view-dialog'
import { COLUMNS, COLUMN_MAP, defaultColumnsFor } from './columns'
import { cn, formatNumber } from '@/lib/utils'
import {
  EMPTY_FILTER, TAB_LABELS, TABS,
  type DateRange, type FilterGroup, type LeadQuery, type SortSpec, type TabId,
} from '@/server/filters/schema'
import type { LeadRow } from '@/server/leads/query'

/**
 * The leads workspace (§22, §36, §37).
 *
 * All filtering, sorting and pagination is server-side — this component holds
 * query *state*, not data. The single `query` object it builds is the same shape
 * sent to /api/leads, saved into a view, and handed to the export endpoint,
 * which is what keeps the exported file identical to the visible set.
 */

interface SavedView {
  id: string
  name: string
  tab: string
  filters: FilterGroup
  sort: SortSpec | null
  columns: string[]
  dateRange: DateRange | null
}

interface Response {
  rows: LeadRow[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  counts: Record<TabId, number>
}

interface EnrichResponse {
  processed: number
  updated: number
  contactsAdded: number
  phonesAdded: number
  emailsAdded: number
  socialsAdded: number
  errors: Array<{ businessId: string; name: string; error: string }>
  /** Businesses still awaiting enrichment after this batch. */
  remaining: number
  /** The batch ended on its time budget rather than running out of work. */
  stoppedEarly: boolean
}

/**
 * Enrichment crawls one site at a time, so a large run cannot fit in a single
 * request. The server returns a bounded batch plus `remaining`; the client keeps
 * going until there is nothing left, reporting cumulative progress as it goes.
 */
const ENRICH_MAX_PASSES = 40

const DATE_PRESET_LABELS: Array<[DateRange['preset'], string]> = [
  ['all', 'All time'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last7', 'Last 7 days'],
  ['last30', 'Last 30 days'],
  ['thisMonth', 'This month'],
  ['lastMonth', 'Last month'],
  ['custom', 'Custom range'],
]

export function LeadsWorkspace({
  tab,
  savedViews,
}: {
  tab: TabId
  savedViews: SavedView[]
}) {
  const [filters, setFilters] = useState<FilterGroup>(EMPTY_FILTER)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sort, setSort] = useState<SortSpec>({ field: 'leadScore', direction: 'desc' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [dateRange, setDateRange] = useState<DateRange>(() =>
    // The "New Leads" tab is defined by a date window, so it opens with one.
    tab === 'new'
      ? { preset: 'last7', field: 'discoveredAt' }
      : { preset: 'all', field: 'discoveredAt' },
  )
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => defaultColumnsFor(tab))

  const [data, setData] = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showFilters, setShowFilters] = useState(false)
  const [showColumns, setShowColumns] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showSaveView, setShowSaveView] = useState(false)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectAllMatching, setSelectAllMatching] = useState(false)
  const [bulkAction, setBulkAction] = useState<'enrich' | 'delete-no-contact' | 'audit-missing' | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const requestId = useRef(0)

  // Debounce the search box so typing does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const query: LeadQuery = useMemo(
    () => ({
      tab,
      filters,
      search: debouncedSearch.trim() || undefined,
      sort,
      dateRange: dateRange.preset === 'all' ? undefined : dateRange,
      page,
      pageSize,
    }),
    [tab, filters, debouncedSearch, sort, dateRange, page, pageSize],
  )

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
      })
      const json = await res.json()
      // Drop responses from superseded requests so fast typing cannot land a
      // stale page after a newer one.
      if (id !== requestId.current) return
      if (!res.ok) {
        setError(json.error ?? 'Could not load leads')
        setData(null)
      } else {
        setData(json)
      }
    } catch {
      if (id === requestId.current) setError('Could not reach the server')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [query])

  useEffect(() => {
    void load()
  }, [load])

  // Any change to the result set invalidates a selection made against the old one.
  useEffect(() => {
    setSelected(new Set())
    setSelectAllMatching(false)
  }, [tab, filters, debouncedSearch, dateRange])

  useEffect(() => {
    setPage(1)
  }, [tab, filters, debouncedSearch, dateRange, pageSize])

  const columns = useMemo(
    () => visibleColumns.map((id) => COLUMN_MAP.get(id)).filter(Boolean) as typeof COLUMNS,
    [visibleColumns],
  )

  const filterCount = countConditions(filters)
  const rows = data?.rows ?? []
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  function toggleSort(field?: string) {
    if (!field) return
    setSort((s) =>
      s.field === field
        ? { field: s.field, direction: s.direction === 'asc' ? 'desc' : 'asc' }
        : ({ field, direction: 'desc' } as SortSpec),
    )
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSelectAllMatching(false)
  }

  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) rows.forEach((r) => next.delete(r.id))
      else rows.forEach((r) => next.add(r.id))
      return next
    })
    setSelectAllMatching(false)
  }

  function applyView(view: SavedView) {
    setFilters(view.filters ?? EMPTY_FILTER)
    if (view.sort) setSort(view.sort)
    if (view.columns?.length) setVisibleColumns(view.columns)
    if (view.dateRange) setDateRange(view.dateRange)
    setPage(1)
  }

  async function enrichMissing() {
    setBulkAction('enrich')
    setActionMessage(null)
    setActionError(null)
    try {
      const ids = Array.from(selected)
      const useFilter = selectAllMatching || ids.length === 0

      let processed = 0
      let updated = 0
      let contactsAdded = 0
      let errorCount = 0
      let remaining = 0

      for (let pass = 0; pass < ENRICH_MAX_PASSES; pass++) {
        const res = await fetch('/api/leads/enrich-missing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ids: useFilter ? undefined : ids,
            query: useFilter ? query : undefined,
            limit: useFilter ? 25 : Math.min(50, Math.max(1, ids.length)),
          }),
        })
        const json = (await res.json()) as Partial<EnrichResponse> & { error?: string }
        if (!res.ok) {
          setActionError(json.error ?? 'Could not enrich missing contacts')
          return
        }

        processed += json.processed ?? 0
        updated += json.updated ?? 0
        contactsAdded += json.contactsAdded ?? 0
        errorCount += json.errors?.length ?? 0
        remaining = json.remaining ?? 0

        setActionMessage(
          `Enriching… checked ${formatNumber(processed)}, added ${formatNumber(contactsAdded)} contacts, ${formatNumber(remaining)} left`,
        )

        // Nothing left, or the batch made no progress — stop rather than spin.
        if (remaining === 0 || (json.processed ?? 0) === 0) break
      }

      setActionMessage(
        [
          `Checked ${formatNumber(processed)} businesses`,
          `updated ${formatNumber(updated)}`,
          `added ${formatNumber(contactsAdded)} contacts`,
          remaining > 0 ? `${formatNumber(remaining)} still pending` : null,
          errorCount > 0 ? `${formatNumber(errorCount)} unreachable` : null,
        ].filter(Boolean).join(' | '),
      )
      await load()
    } catch {
      setActionError('Could not reach the server')
    } finally {
      setBulkAction(null)
    }
  }

  async function auditMissing() {
    setActionMessage(null)
    setActionError(null)
    setBulkAction('audit-missing')

    try {
      // Ask the server what this would do before committing to hours of crawling.
      const preview = await fetch('/api/leads/audit-missing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, dryRun: true }),
      })
      const plan = await preview.json()
      if (!preview.ok) {
        setActionError(plan.error ?? 'Could not check for unaudited businesses')
        return
      }

      if (plan.matched === 0) {
        setActionMessage('Every business matching this view has already been audited.')
        return
      }

      const capped = plan.capped ? ` Only the first ${formatNumber(plan.limit)} will be queued.` : ''
      const ok = window.confirm(
        `Queue audits for ${formatNumber(plan.matched)} business${plan.matched === 1 ? '' : 'es'}?

` +
          `${formatNumber(plan.withWebsite)} have a website and will be crawled and scored.
` +
          `${formatNumber(plan.withoutWebsite)} have no website and will be scored as website-creation leads.

` +
          `This runs in the background and can take a while.${capped}`,
      )
      if (!ok) return

      const res = await fetch('/api/leads/audit-missing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const json = await res.json()
      if (!res.ok) {
        setActionError(json.error ?? 'Could not queue audits')
        return
      }

      setActionMessage(
        `Queued ${formatNumber(json.queued)} audit${json.queued === 1 ? '' : 's'}. ` +
          'They run in the background — make sure the worker is running.',
      )
      await load()
    } catch {
      setActionError('Could not reach the server')
    } finally {
      setBulkAction(null)
    }
  }

  async function deleteNoContact() {
    const ok = window.confirm(
      'Delete every lead in this workspace with no phone, email, website or social profile? This cannot be undone.',
    )
    if (!ok) return

    setBulkAction('delete-no-contact')
    setActionMessage(null)
    setActionError(null)
    try {
      const res = await fetch('/api/leads/no-contact', { method: 'DELETE' })
      const json = (await res.json()) as { deleted?: number; error?: string }
      if (!res.ok) {
        setActionError(json.error ?? 'Could not delete no-contact leads')
        return
      }
      setSelected(new Set())
      setSelectAllMatching(false)
      setActionMessage(`Deleted ${formatNumber(json.deleted ?? 0)} no-contact leads.`)
      await load()
    } catch {
      setActionError('Could not reach the server')
    } finally {
      setBulkAction(null)
    }
  }

  const selectionCount = selectAllMatching ? (data?.total ?? 0) : selected.size

  return (
    <div className="flex h-full flex-col">
      {/* ── Tab strip with live counts (§36) ─────────────────────────────── */}
      <div className="flex items-end gap-1 overflow-x-auto border-b border-border bg-surface px-5 pt-3">
        {TABS.map((t) => {
          const active = t === tab
          const count = data?.counts?.[t]
          return (
            <Link
              key={t}
              href={`/leads/${t}`}
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 px-3 py-2 text-[13px] transition-colors',
                active
                  ? 'border-accent font-semibold text-accent'
                  : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {TAB_LABELS[t]}
              {count !== undefined && (
                <span
                  className={cn(
                    'tnum rounded px-1.5 py-0.5 text-2xs font-medium',
                    active ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-subtle',
                  )}
                >
                  {formatNumber(count)}
                </span>
              )}
            </Link>
          )
        })}
      </div>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, domain, phone, email, address…"
            className="h-8 pl-8 text-[13px]"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-fg"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <Button
          variant={showFilters || filterCount > 0 ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setShowFilters((v) => !v)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {filterCount > 0 && (
            <span className="tnum ml-0.5 rounded bg-white/20 px-1.5 text-2xs">{filterCount}</span>
          )}
        </Button>

        <Select
          value={dateRange.preset}
          onChange={(e) =>
            setDateRange((d) => ({ ...d, preset: e.target.value as DateRange['preset'] }))
          }
          className="h-8 w-[140px] text-[13px]"
          aria-label="Date range"
        >
          {DATE_PRESET_LABELS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>

        {dateRange.preset === 'custom' && (
          <>
            <Input
              type="date"
              className="h-8 w-[140px] text-[13px]"
              onChange={(e) =>
                setDateRange((d) => ({
                  ...d,
                  from: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                }))
              }
            />
            <Input
              type="date"
              className="h-8 w-[140px] text-[13px]"
              onChange={(e) =>
                setDateRange((d) => ({
                  ...d,
                  to: e.target.value
                    ? new Date(`${e.target.value}T23:59:59`).toISOString()
                    : undefined,
                }))
              }
            />
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {savedViews.length > 0 && (
            <Select
              className="h-8 w-[170px] text-[13px]"
              defaultValue=""
              onChange={(e) => {
                const v = savedViews.find((s) => s.id === e.target.value)
                if (v) applyView(v)
              }}
              aria-label="Saved views"
            >
              <option value="">Saved views…</option>
              {savedViews.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          )}

          <Button variant="secondary" size="sm" onClick={() => setShowSaveView(true)}>
            <Bookmark className="h-3.5 w-3.5" />
            Save view
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void enrichMissing()}
            loading={bulkAction === 'enrich'}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Enrich missing
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void auditMissing()}
            loading={bulkAction === 'audit-missing'}
            title="Queue audits for businesses that have never been audited"
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            Audit unaudited
          </Button>

          <Button
            variant="danger"
            size="sm"
            onClick={() => void deleteNoContact()}
            loading={bulkAction === 'delete-no-contact'}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete no-contact
          </Button>

          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setShowColumns((v) => !v)}>
              <Columns3 className="h-3.5 w-3.5" />
              Columns
            </Button>
            {showColumns && (
              <ColumnMenu
                visible={visibleColumns}
                onChange={setVisibleColumns}
                onClose={() => setShowColumns(false)}
                onReset={() => setVisibleColumns(defaultColumnsFor(tab))}
              />
            )}
          </div>

          <Button variant="ghost" size="icon" onClick={() => void load()} title="Refresh">
            <RotateCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>

          <Button variant="primary" size="sm" onClick={() => setShowExport(true)}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </div>

      {(actionMessage || actionError) && (
        <div
          className={cn(
            'flex items-center gap-2 border-b px-5 py-2 text-[13px]',
            actionError
              ? 'border-danger/20 bg-danger/10 text-danger'
              : 'border-ok/20 bg-ok/10 text-ok',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{actionError ?? actionMessage}</span>
          <button
            onClick={() => {
              setActionMessage(null)
              setActionError(null)
            }}
            className="text-current opacity-70 hover:opacity-100"
            aria-label="Dismiss message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {showFilters && (
        <div className="border-b border-border bg-surface-2/60 px-5 py-3">
          <FilterBuilder value={filters} onChange={setFilters} />
          {filterCount > 0 && (
            <button
              onClick={() => setFilters(EMPTY_FILTER)}
              className="mt-2 text-2xs text-muted underline underline-offset-2 hover:text-fg"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* ── Selection banner ─────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 border-b border-accent/20 bg-accent-soft px-5 py-2 text-[13px]">
          <Check className="h-4 w-4 text-accent" />
          <span className="font-medium text-accent">
            {formatNumber(selectionCount)} selected
          </span>
          {!selectAllMatching && data && data.total > selected.size && (
            <button
              onClick={() => setSelectAllMatching(true)}
              className="text-accent underline underline-offset-2"
            >
              Select all {formatNumber(data.total)} matching this filter
            </button>
          )}
          <button
            onClick={() => {
              setSelected(new Set())
              setSelectAllMatching(false)
            }}
            className="ml-auto text-muted hover:text-fg"
          >
            Clear selection
          </button>
          <Button variant="primary" size="sm" onClick={() => setShowExport(true)}>
            <Download className="h-3.5 w-3.5" />
            Export selected
          </Button>
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <EmptyState
            title="Could not load leads"
            description={error}
            action={<Button onClick={() => void load()}>Try again</Button>}
          />
        ) : loading && !data ? (
          <TableSkeleton rows={10} cols={Math.min(7, columns.length)} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Database className="h-5 w-5" />}
            title={
              filterCount > 0 || debouncedSearch
                ? 'No businesses match these filters'
                : `No businesses in ${TAB_LABELS[tab]} yet`
            }
            description={
              filterCount > 0 || debouncedSearch
                ? 'Try widening the filters, or clear them to see the whole tab.'
                : tab === 'all'
                  ? 'Run a discovery to start building your lead database.'
                  : 'Businesses appear here once an audit detects this opportunity. Run a discovery, or wait for queued audits to finish.'
            }
            action={
              filterCount > 0 ? (
                <Button onClick={() => setFilters(EMPTY_FILTER)}>Clear filters</Button>
              ) : (
                <Link href="/discovery/new">
                  <Button variant="primary">Start a discovery</Button>
                </Link>
              )
            }
          />
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="sticky-col w-10 border-b border-border bg-surface-2 px-3 py-2">
                  <Checkbox
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    aria-label="Select all on page"
                  />
                </th>
                {columns.map((col, i) => {
                  const sortable = Boolean(col.sortField)
                  const active = sort.field === col.sortField
                  return (
                    <th
                      key={col.id}
                      style={{ minWidth: col.width }}
                      className={cn(
                        'whitespace-nowrap border-b border-border bg-surface-2 px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-muted',
                        col.align === 'right' && 'text-right',
                        i === 0 && 'sticky-col sticky-col-shadow left-10 bg-surface-2',
                      )}
                    >
                      {sortable ? (
                        <button
                          onClick={() => toggleSort(col.sortField)}
                          className={cn(
                            'inline-flex items-center gap-1 hover:text-fg',
                            active && 'text-accent',
                          )}
                        >
                          {col.label}
                          {active &&
                            (sort.direction === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : (
                              <ArrowDown className="h-3 w-3" />
                            ))}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>

            <tbody className={cn(loading && 'opacity-60 transition-opacity')}>
              {rows.map((row) => (
                <tr key={row.id} className="group hover:bg-accent-soft/40">
                  <td className="sticky-col border-b border-border px-3 py-2 group-hover:bg-accent-soft/40">
                    <Checkbox
                      checked={selected.has(row.id)}
                      onChange={() => toggleRow(row.id)}
                      aria-label={`Select ${row.name}`}
                    />
                  </td>
                  {columns.map((col, i) => (
                    <td
                      key={col.id}
                      className={cn(
                        'border-b border-border px-3 py-2 align-middle',
                        col.align === 'right' && 'text-right',
                        i === 0 &&
                          'sticky-col sticky-col-shadow left-10 group-hover:bg-accent-soft/40',
                      )}
                    >
                      <div className="max-w-[420px] truncate">{col.render(row)}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {data && data.total > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-surface px-5 py-2.5 text-[13px]">
          <div className="text-muted">
            <span className="tnum font-medium text-fg">
              {formatNumber((data.page - 1) * data.pageSize + 1)}–
              {formatNumber(Math.min(data.page * data.pageSize, data.total))}
            </span>{' '}
            of <span className="tnum font-medium text-fg">{formatNumber(data.total)}</span>
            {(filterCount > 0 || debouncedSearch) && (
              <Tooltip label="Export Current Filter will produce exactly this set.">
                <Badge tone="accent" className="ml-2">
                  filtered
                </Badge>
              </Tooltip>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Select
              value={String(pageSize)}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-8 w-[92px] text-[13px]"
              aria-label="Rows per page"
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n} rows
                </option>
              ))}
            </Select>

            <Button
              variant="secondary"
              size="icon"
              disabled={data.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="tnum px-1 text-muted">
              {data.page} / {data.pageCount}
            </span>
            <Button
              variant="secondary"
              size="icon"
              disabled={data.page >= data.pageCount}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <ExportDialog
        open={showExport}
        onClose={() => setShowExport(false)}
        tab={tab}
        query={query}
        selectedIds={Array.from(selected)}
        selectAllMatching={selectAllMatching}
        filteredCount={data?.total ?? 0}
        hasFilters={filterCount > 0 || Boolean(debouncedSearch) || dateRange.preset !== 'all'}
      />

      <SaveViewDialog
        open={showSaveView}
        onClose={() => setShowSaveView(false)}
        tab={tab}
        filters={filters}
        sort={sort}
        columns={visibleColumns}
        dateRange={dateRange}
      />
    </div>
  )
}

function ColumnMenu({
  visible,
  onChange,
  onClose,
  onReset,
}: {
  visible: string[]
  onChange: (next: string[]) => void
  onClose: () => void
  onReset: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const groups = useMemo(() => {
    const map = new Map<string, typeof COLUMNS>()
    for (const c of COLUMNS) {
      const arr = map.get(c.group) ?? []
      arr.push(c)
      map.set(c.group, arr)
    }
    return Array.from(map.entries())
  }, [])

  function toggle(id: string) {
    onChange(
      visible.includes(id) ? visible.filter((v) => v !== id) : [...visible, id],
    )
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-40 mt-1.5 max-h-[70vh] w-64 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-pop"
    >
      <div className="flex items-center justify-between px-1.5 pb-2">
        <span className="text-2xs font-semibold uppercase tracking-wide text-subtle">
          Visible columns
        </span>
        <button onClick={onReset} className="text-2xs text-accent hover:underline">
          Reset
        </button>
      </div>
      {groups.map(([group, cols]) => (
        <div key={group} className="mb-1.5">
          <div className="px-1.5 py-1 text-2xs font-semibold text-subtle">{group}</div>
          {cols.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-2"
            >
              <Checkbox checked={visible.includes(c.id)} onChange={() => toggle(c.id)} />
              {c.label}
            </label>
          ))}
        </div>
      ))}
    </div>
  )
}
