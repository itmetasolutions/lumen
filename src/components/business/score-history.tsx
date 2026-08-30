'use client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { Badge, Card, CardHeader, Select } from '@/components/ui/primitives'
import { cn, formatDate } from '@/lib/utils'

/**
 * §26 — historical comparison across audits.
 *
 * Because audits are append-only, this is just a read over the stored snapshots.
 * The delta against the previous audit is what makes "we fixed it" verifiable.
 */

interface HistoryEntry {
  id: string
  startedAt: string
  status: string
  isDemo: boolean
  seoHealth: number | null
  uxHealth: number | null
  technicalHealth: number | null
  perfHealthMobile: number | null
  perfHealthDesktop: number | null
  leadScore: number | null
  issueCount: number
}

const METRICS = [
  { id: 'perfHealthMobile', label: 'Performance (mobile)' },
  { id: 'perfHealthDesktop', label: 'Performance (desktop)' },
  { id: 'seoHealth', label: 'SEO health' },
  { id: 'uxHealth', label: 'UX health' },
  { id: 'technicalHealth', label: 'Technical health' },
  { id: 'leadScore', label: 'Lead score' },
] as const

export function ScoreHistory({ history }: { history: HistoryEntry[] }) {
  const [metric, setMetric] = useState<(typeof METRICS)[number]['id']>('perfHealthMobile')

  if (history.length === 0) return null

  const series = history
    .map((h) => ({ date: h.startedAt, value: h[metric], issues: h.issueCount, demo: h.isDemo }))
    .filter((p) => p.value !== null) as Array<{
    date: string
    value: number
    issues: number
    demo: boolean
  }>

  return (
    <Card>
      <CardHeader
        title="Audit history"
        description={`${history.length} audit${history.length === 1 ? '' : 's'} on record`}
      />

      <div className="px-5 py-3">
        <Select
          value={metric}
          onChange={(e) => setMetric(e.target.value as never)}
          className="h-8 text-[13px]"
        >
          {METRICS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </div>

      {series.length === 0 ? (
        <p className="px-5 pb-4 text-[13px] text-muted">
          No audit has produced this metric yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {series
            .slice()
            .reverse()
            .map((point, i, arr) => {
              // arr is newest-first, so the "previous" audit is the next element.
              const previous = arr[i + 1]
              const delta = previous ? point.value - previous.value : null
              return (
                <li key={point.date} className="flex items-center gap-3 px-5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{formatDate(point.date)}</div>
                    <div className="text-2xs text-subtle">{point.issues} findings</div>
                  </div>
                  {point.demo && <Badge tone="demo">DEMO</Badge>}
                  <span className="tnum text-[15px] font-semibold">{point.value}</span>
                  {delta !== null && (
                    <span
                      className={cn(
                        'tnum inline-flex w-14 items-center justify-end gap-0.5 text-2xs font-medium',
                        delta > 0 ? 'text-ok' : delta < 0 ? 'text-danger' : 'text-subtle',
                      )}
                    >
                      {delta > 0 ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : delta < 0 ? (
                        <ArrowDown className="h-3 w-3" />
                      ) : (
                        <Minus className="h-3 w-3" />
                      )}
                      {delta > 0 ? `+${delta}` : delta}
                    </span>
                  )}
                </li>
              )
            })}
        </ul>
      )}
    </Card>
  )
}
