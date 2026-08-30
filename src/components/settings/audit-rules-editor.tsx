'use client'

import { useState } from 'react'
import { Save, Check } from 'lucide-react'
import { Button, Card, CardHeader, Input } from '@/components/ui/primitives'

/**
 * §33 — cost controls.
 *
 * External APIs cost money and community endpoints cost goodwill. These caps are
 * enforced in the worker before any external call, not merely displayed.
 */

interface Settings {
  maxBusinessesPerDiscovery: number
  maxPagesPerSite: number
  maxConcurrentAudits: number
  dailyPerformanceTests: number
  dailyAiAnalyses: number
  performanceCacheHours: number
  aiCacheHours: number
}

const FIELDS: Array<{
  key: keyof Settings
  label: string
  hint: string
  group: string
}> = [
  {
    key: 'maxBusinessesPerDiscovery',
    label: 'Max businesses per discovery',
    hint: 'Discovery stops once this many unique businesses have been touched.',
    group: 'Discovery limits',
  },
  {
    key: 'maxPagesPerSite',
    label: 'Max pages crawled per site',
    hint: 'Upper bound regardless of audit depth. Protects both you and the audited site.',
    group: 'Crawl limits',
  },
  {
    key: 'maxConcurrentAudits',
    label: 'Concurrent audits',
    hint: 'How many websites the worker audits at once. Raise only if the machine can take it.',
    group: 'Crawl limits',
  },
  {
    key: 'dailyPerformanceTests',
    label: 'Daily performance tests',
    hint: 'Hard cap on PageSpeed/Lighthouse runs per day for this workspace.',
    group: 'Daily budgets',
  },
  {
    key: 'dailyAiAnalyses',
    label: 'Daily AI analyses',
    hint: 'Hard cap on AI-assisted screenshot reviews per day.',
    group: 'Daily budgets',
  },
  {
    key: 'performanceCacheHours',
    label: 'Performance result cache (hours)',
    hint: 'A performance measurement newer than this is reused instead of re-run. Manual re-audits always bypass it.',
    group: 'Caching',
  },
  {
    key: 'aiCacheHours',
    label: 'AI result cache (hours)',
    hint: 'How long an AI review is considered current.',
    group: 'Caching',
  },
]

export function AuditRulesEditor({
  initial,
  canEdit,
}: {
  initial: Settings
  canEdit: boolean
}) {
  const [values, setValues] = useState<Settings>(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const groups = Array.from(new Set(FIELDS.map((f) => f.group)))

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/audit-rules', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? 'Could not save')
        return
      }
      setSaved(true)
    } catch {
      setError('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[13px] leading-5 text-muted">
          These caps are enforced in the worker before any external request is made, so a
          runaway search cannot quietly spend a month&rsquo;s API budget.
        </p>
        <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!canEdit}>
          {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {saved ? 'Saved' : 'Save limits'}
        </Button>
      </div>

      {!canEdit && (
        <Card className="px-4 py-3 text-[13px] text-muted">
          You need the Admin or Owner role to change these limits.
        </Card>
      )}

      {error && (
        <Card className="border-danger/30 px-4 py-3 text-[13px] text-danger">{error}</Card>
      )}

      {groups.map((group) => (
        <Card key={group}>
          <CardHeader title={group} />
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
            {FIELDS.filter((f) => f.group === group).map((f) => (
              <div key={String(f.key)}>
                <label className="mb-1.5 block text-[13px] font-medium" htmlFor={String(f.key)}>
                  {f.label}
                </label>
                <Input
                  id={String(f.key)}
                  type="number"
                  min={0}
                  className="tnum"
                  value={values[f.key]}
                  disabled={!canEdit}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))
                    setSaved(false)
                  }}
                />
                <p className="mt-1 text-2xs leading-4 text-subtle">{f.hint}</p>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
