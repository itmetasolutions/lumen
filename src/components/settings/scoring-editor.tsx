'use client'

import { useState } from 'react'
import { RotateCcw, Save, Check } from 'lucide-react'
import { Badge, Button, Card, CardHeader, Input } from '@/components/ui/primitives'
import type { ScoringWeights } from '@/server/scoring/weights'

/**
 * §14 — the scoring weights editor.
 *
 * Exposed rather than buried so the scores can be defended: if a user disagrees
 * that "no phone number" should cost a lead 20 points, they can change it, and
 * they can see exactly which number produced the ranking.
 */

const GROUPS: Array<{
  key: keyof ScoringWeights
  title: string
  description: string
  fields: Array<{ key: string; label: string; hint: string; max?: number; step?: number }>
}> = [
  {
    key: 'severity',
    title: 'Severity penalties',
    description: 'Points deducted from a 100-point health score per finding, before the confidence multiplier.',
    fields: [
      { key: 'CRITICAL', label: 'Critical', hint: 'Site is broken or invisible to search' },
      { key: 'HIGH', label: 'High', hint: 'Materially damages the visitor experience' },
      { key: 'MEDIUM', label: 'Medium', hint: 'Meaningful but not urgent' },
      { key: 'LOW', label: 'Low', hint: 'Worth fixing, low impact' },
      { key: 'INFO', label: 'Info', hint: 'Observation only' },
    ],
  },
  {
    key: 'confidence',
    title: 'Confidence multipliers',
    description: 'A less certain finding should dent a score less than a definite one.',
    fields: [
      { key: 'HIGH', label: 'High', hint: 'Directly measured', max: 1, step: 0.05 },
      { key: 'MEDIUM', label: 'Medium', hint: 'Inferred from measurement', max: 1, step: 0.05 },
      { key: 'LOW', label: 'Low', hint: 'Heuristic or AI-assisted', max: 1, step: 0.05 },
    ],
  },
  {
    key: 'websiteHealth',
    title: 'Website health composition',
    description: 'How the four domain scores combine into one overall website health score.',
    fields: [
      { key: 'seo', label: 'SEO', hint: '', max: 1, step: 0.01 },
      { key: 'performance', label: 'Performance', hint: '', max: 1, step: 0.01 },
      { key: 'ux', label: 'UX', hint: '', max: 1, step: 0.01 },
      { key: 'technical', label: 'Technical', hint: '', max: 1, step: 0.01 },
    ],
  },
  {
    key: 'opportunity',
    title: 'Opportunity scoring',
    description: 'Opportunity rises with the health gap, the weight of evidence and the value of the business.',
    fields: [
      { key: 'healthGap', label: 'Health gap', hint: 'How much a poor score drives opportunity', max: 1, step: 0.01 },
      { key: 'evidenceStrength', label: 'Evidence strength', hint: 'Volume and severity of findings', max: 1, step: 0.01 },
      { key: 'businessValue', label: 'Business value', hint: 'Reviews, rating, data confidence', max: 1, step: 0.01 },
      { key: 'uncertaintyPenalty', label: 'Uncertainty penalty', hint: 'Deducted when evidence is thin', max: 1, step: 0.01 },
      { key: 'triggerThreshold', label: 'Trigger threshold', hint: 'Score at which an opportunity is flagged' },
    ],
  },
  {
    key: 'leadPriority',
    title: 'Lead priority',
    description: 'Deliberately not dominated by "worst website" — reachability and credibility matter as much as need.',
    fields: [
      { key: 'need', label: 'Need', hint: 'Strongest opportunity score', max: 1, step: 0.01 },
      { key: 'contactability', label: 'Contactability', hint: 'Phone, email, social', max: 1, step: 0.01 },
      { key: 'credibility', label: 'Credibility', hint: 'Reviews, rating, data confidence', max: 1, step: 0.01 },
      { key: 'evidence', label: 'Evidence', hint: 'Documented findings', max: 1, step: 0.01 },
      { key: 'hotThreshold', label: 'HOT threshold', hint: 'Lead score at or above this is HOT' },
      { key: 'warmThreshold', label: 'WARM threshold', hint: 'Lead score at or above this is WARM' },
    ],
  },
  {
    key: 'speed',
    title: 'Speed thresholds',
    description: 'Where a performance score stops being acceptable, and how mobile is weighted against desktop.',
    fields: [
      { key: 'poorScore', label: 'Poor below', hint: 'Treated as the slowest band' },
      { key: 'weakScore', label: 'Weak below', hint: 'Below the good threshold' },
      { key: 'mobileWeight', label: 'Mobile weight', hint: 'Share of the composite that is mobile', max: 1, step: 0.05 },
    ],
  },
]

export function ScoringEditor({
  initial,
  defaults,
  canEdit,
}: {
  initial: ScoringWeights
  defaults: ScoringWeights
  canEdit: boolean
}) {
  const [weights, setWeights] = useState<ScoringWeights>(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(group: string, field: string, value: number) {
    setWeights((w) => ({
      ...w,
      [group]: { ...(w[group as keyof ScoringWeights] as object), [field]: value },
    }))
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/scoring', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(weights),
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
          These weights apply to audits scored from now on. Existing audits keep the score
          snapshot they were written with, so historical comparisons stay meaningful.
        </p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setWeights(defaults)
              setSaved(false)
            }}
            disabled={!canEdit}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </Button>
          <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!canEdit}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : 'Save weights'}
          </Button>
        </div>
      </div>

      {!canEdit && (
        <Card className="px-4 py-3 text-[13px] text-muted">
          You need the Admin or Owner role to change scoring weights.
        </Card>
      )}

      {error && (
        <Card className="border-danger/30 px-4 py-3 text-[13px] text-danger">{error}</Card>
      )}

      {GROUPS.map((group) => {
        const values = weights[group.key] as unknown as Record<string, number>
        const defaultValues = defaults[group.key] as unknown as Record<string, number>
        return (
          <Card key={String(group.key)}>
            <CardHeader title={group.title} description={group.description} />
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.fields.map((f) => {
                const value = values[f.key] ?? 0
                const isDefault = value === defaultValues[f.key]
                return (
                  <div key={f.key}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <label className="text-[13px] font-medium" htmlFor={`${String(group.key)}-${f.key}`}>
                        {f.label}
                      </label>
                      {!isDefault && <Badge tone="accent">changed</Badge>}
                    </div>
                    <Input
                      id={`${String(group.key)}-${f.key}`}
                      type="number"
                      min={0}
                      max={f.max ?? 100}
                      step={f.step ?? 1}
                      value={value}
                      disabled={!canEdit}
                      onChange={(e) =>
                        set(String(group.key), f.key, Number(e.target.value))
                      }
                      className="tnum"
                    />
                    {f.hint && (
                      <p className="mt-1 text-2xs leading-4 text-subtle">{f.hint}</p>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        )
      })}
    </div>
  )
}
