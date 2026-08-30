'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Modal } from '@/components/ui/primitives'
import { countConditions } from '@/components/filters/filter-builder'
import type { DateRange, FilterGroup, SortSpec, TabId } from '@/server/filters/schema'
import { TAB_LABELS } from '@/server/filters/schema'

/**
 * §38 — a saved view captures the tab, filters, sort, columns *and* date range,
 * so reopening it reproduces the exact working state rather than an approximation.
 */
export function SaveViewDialog({
  open,
  onClose,
  tab,
  filters,
  sort,
  columns,
  dateRange,
}: {
  open: boolean
  onClose: () => void
  tab: TabId
  filters: FilterGroup
  sort: SortSpec
  columns: string[]
  dateRange: DateRange
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!name.trim()) {
      setError('Give the view a name')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          tab,
          filters,
          sort,
          columns,
          dateRange: dateRange.preset === 'all' ? undefined : dateRange,
          isShared: true,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not save the view')
        setSaving(false)
        return
      }
      setName('')
      onClose()
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save this view"
      description="Stores the current tab, filters, sort order, visible columns and date range."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Save view
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="viewName">View name</Label>
          <Input
            id="viewName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Manchester Dentists — Slow Websites"
            onKeyDown={(e) => e.key === 'Enter' && save()}
            autoFocus
          />
          <p className="mt-1.5 text-2xs text-subtle">
            Saving with an existing name updates that view.
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[13px]">
          <Row label="Tab" value={TAB_LABELS[tab]} />
          <Row label="Conditions" value={String(countConditions(filters))} />
          <Row label="Sort" value={`${sort.field} ${sort.direction}`} />
          <Row label="Columns" value={String(columns.length)} />
          <Row label="Date range" value={dateRange.preset} />
        </dl>

        {error && (
          <p className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </>
  )
}
