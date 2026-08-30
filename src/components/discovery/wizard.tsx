'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  MapPin, Briefcase, Layers, Gauge, Rocket, Check, AlertTriangle,
  Info, ChevronRight, ChevronLeft, X,
} from 'lucide-react'
import {
  Badge, Button, Card, Checkbox, Input, Label, Select, Tooltip,
} from '@/components/ui/primitives'
import { SYNONYM_INDUSTRIES } from '@/server/discovery/expansion'
import { cn } from '@/lib/utils'

/**
 * Discovery wizard (§16).
 *
 * Five steps, each answering one question. The cost/coverage panel updates as
 * choices are made, because "how many API calls will this make" is exactly the
 * thing users discover too late otherwise (§33).
 */

interface ProviderInfo {
  id: string
  label: string
  description: string
  isDemo: boolean
  termsUrl?: string
  status: { state: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'; detail: string }
  capabilities: {
    ratings: boolean
    reviewCounts: boolean
    phone: boolean
    website: boolean
    email: boolean
    maxResultsPerQuery: number
  }
}

const STEPS = [
  { id: 1, label: 'Location', icon: MapPin },
  { id: 2, label: 'Industry', icon: Briefcase },
  { id: 3, label: 'Sources', icon: Layers },
  { id: 4, label: 'Audit depth', icon: Gauge },
  { id: 5, label: 'Review', icon: Rocket },
] as const

const RADIUS_OPTIONS = [
  { value: 2000, label: '2 km — a neighbourhood' },
  { value: 5000, label: '5 km — a district' },
  { value: 12000, label: '12 km — a city' },
  { value: 25000, label: '25 km — a metro area' },
  { value: 50000, label: '50 km — a wide region' },
]

const DEPTHS = [
  {
    value: 'QUICK' as const,
    title: 'Quick',
    detail: 'Homepage only. Website reachability, core SEO, performance and technical checks.',
    time: '~10–20s per site',
    note: 'No browser rendering, so no screenshots or layout analysis.',
  },
  {
    value: 'STANDARD' as const,
    title: 'Standard',
    detail: 'Homepage plus contact, about and service pages. Full SEO, performance, technical and UX with screenshots.',
    time: '~45–90s per site',
    note: 'Recommended for most lead generation.',
  },
  {
    value: 'DEEP' as const,
    title: 'Deep',
    detail: 'Wider crawl, more internal links checked, detailed SEO and accessibility analysis.',
    time: '~3–6 min per site',
    note: 'Use for shortlisted prospects rather than a whole market.',
  },
]

export function DiscoveryWizard({ providers }: { providers: ProviderInfo[] }) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [country, setCountry] = useState('')
  const [region, setRegion] = useState('')
  const [city, setCity] = useState('')
  const [area, setArea] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [radius, setRadius] = useState(12000)

  const [industry, setIndustry] = useState('')
  const [keywords, setKeywords] = useState<string[]>([])
  const [keywordDraft, setKeywordDraft] = useState('')
  const [exclusions, setExclusions] = useState<string[]>([])
  const [exclusionDraft, setExclusionDraft] = useState('')
  const [expandTerms, setExpandTerms] = useState(true)

  const available = providers.filter((p) => p.status.state === 'CONNECTED')
  const [selectedProviders, setSelectedProviders] = useState<string[]>(() => {
    return providers.filter((p) => p.status.state === 'CONNECTED').map((p) => p.id)
  })

  const [depth, setDepth] = useState<'QUICK' | 'STANDARD' | 'DEEP'>('STANDARD')

  const hasLocation = Boolean(country || region || city || area || postalCode)
  const canContinue =
    step === 1 ? hasLocation
    : step === 2 ? industry.trim().length > 0
    : step === 3 ? selectedProviders.length > 0
    : true

  const estimate = useMemo(() => {
    // Mirrors tiling.planTiles: cells grow with area, capped at 144.
    const cellRadius = 2000
    const cells =
      radius <= cellRadius
        ? 1
        : Math.min(144, Math.ceil((radius * 2) / (cellRadius * 1.5)) ** 2)
    const terms = expandTerms ? 5 : 1 + keywords.length
    const queries = cells * terms * selectedProviders.length
    return { cells, terms, queries }
  }, [radius, expandTerms, keywords.length, selectedProviders.length])

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/discovery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          country: country || undefined,
          region: region || undefined,
          city: city || undefined,
          area: area || undefined,
          postalCode: postalCode || undefined,
          radiusMeters: radius,
          industry: industry.trim(),
          keywords,
          exclusions,
          expandTerms,
          providers: selectedProviders,
          depth,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not start the discovery')
        setSubmitting(false)
        return
      }
      router.push(`/discovery/jobs/${json.id}`)
    } catch {
      setError('Could not reach the server')
      setSubmitting(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div>
        <Stepper current={step} onJump={(s) => s < step && setStep(s)} />

        <Card className="mt-5">
          <div className="p-5">
            {step === 1 && (
              <Step title="Where should we search?" hint="Fill in as much as you know. Anything left blank widens the search.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Country" value={country} onChange={setCountry} placeholder="United Kingdom" />
                  <Field label="State / Region" value={region} onChange={setRegion} placeholder="Greater Manchester" />
                  <Field label="City" value={city} onChange={setCity} placeholder="Manchester" />
                  <Field label="Area / Neighbourhood" value={area} onChange={setArea} placeholder="Didsbury" optional />
                  <Field label="Postal code" value={postalCode} onChange={setPostalCode} placeholder="M20 2RN" optional />
                  <div>
                    <Label htmlFor="radius">Search radius</Label>
                    <Select id="radius" value={String(radius)} onChange={(e) => setRadius(Number(e.target.value))}>
                      {RADIUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                <Note icon={<Info className="h-3.5 w-3.5" />}>
                  Place-search APIs cap results per query, so a large radius is split into
                  overlapping cells and each is searched separately. That is what makes
                  coverage of a whole city possible — and what makes it cost more.
                </Note>
              </Step>
            )}

            {step === 2 && (
              <Step title="What kind of business?" hint="Your own words are always searched first. Expansions are additional queries, clearly marked.">
                <div>
                  <Label htmlFor="industry">Industry or business type</Label>
                  <Input
                    id="industry"
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                    placeholder="Dentists"
                    list="industry-suggestions"
                  />
                  <datalist id="industry-suggestions">
                    {SYNONYM_INDUSTRIES.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>

                <TagInput
                  label="Extra keywords"
                  hint="searched as-is, in addition to the industry"
                  values={keywords}
                  draft={keywordDraft}
                  setDraft={setKeywordDraft}
                  onAdd={(v) => setKeywords((k) => [...k, v])}
                  onRemove={(i) => setKeywords((k) => k.filter((_, x) => x !== i))}
                  placeholder="cosmetic dentistry"
                />

                <TagInput
                  label="Exclusions"
                  hint="results whose name or category contains these are dropped"
                  values={exclusions}
                  draft={exclusionDraft}
                  setDraft={setExclusionDraft}
                  onAdd={(v) => setExclusions((k) => [...k, v])}
                  onRemove={(i) => setExclusions((k) => k.filter((_, x) => x !== i))}
                  placeholder="hospital"
                />

                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3">
                  <Checkbox
                    checked={expandTerms}
                    onChange={(e) => setExpandTerms(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-[13px] font-medium">
                      Expand into related search terms
                    </span>
                    <span className="mt-0.5 block text-2xs leading-4 text-muted">
                      Searches curated variations too — for &ldquo;plumber&rdquo;: plumbing
                      company, emergency plumber, plumbing contractor, drain service. Every
                      expanded query is recorded separately in the coverage report, and
                      multiplies the number of API calls.
                    </span>
                  </span>
                </label>
              </Step>
            )}

            {step === 3 && (
              <Step title="Which sources?" hint="Results from every selected source are merged into one record per business.">
                <div className="space-y-2">
                  {providers.map((p) => {
                    const usable = p.status.state === 'CONNECTED'
                    const selected = selectedProviders.includes(p.id)
                    return (
                      <div
                        key={p.id}
                        className={cn(
                          'rounded-lg border p-3 transition-colors',
                          selected ? 'border-accent bg-accent-soft' : 'border-border',
                          !usable && 'opacity-60',
                        )}
                      >
                        <label className="flex cursor-pointer items-start gap-3">
                          <Checkbox
                            checked={selected}
                            disabled={!usable}
                            onChange={() =>
                              setSelectedProviders((prev) =>
                                prev.includes(p.id)
                                  ? prev.filter((id) => id !== p.id)
                                  : [...prev, p.id],
                              )
                            }
                            className="mt-0.5"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-[13px] font-medium">{p.label}</span>
                              <StatusBadge state={p.status.state} />
                              {p.isDemo && <Badge tone="demo">DEMO DATA</Badge>}
                            </span>
                            <span className="mt-1 block text-2xs leading-4 text-muted">
                              {p.description}
                            </span>
                            {!usable && (
                              <span className="mt-1.5 block text-2xs leading-4 text-warn">
                                {p.status.detail}
                              </span>
                            )}
                            <span className="mt-1.5 flex flex-wrap gap-1">
                              {p.capabilities.ratings && <Badge tone="outline">ratings</Badge>}
                              {p.capabilities.phone && <Badge tone="outline">phone</Badge>}
                              {p.capabilities.website && <Badge tone="outline">website</Badge>}
                              {p.capabilities.email && <Badge tone="outline">email</Badge>}
                              <Badge tone="outline">
                                ≤{p.capabilities.maxResultsPerQuery}/query
                              </Badge>
                            </span>
                          </span>
                        </label>
                      </div>
                    )
                  })}
                </div>

                {available.length === 0 && (
                  <Note tone="warn" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
                    No discovery provider is connected. Add a key in Settings &gt;
                    Connections, or wait for OpenStreetMap to become reachable.
                  </Note>
                )}
              </Step>
            )}

            {step === 4 && (
              <Step title="How deeply should we audit?" hint="Applies to every business with a website. You can re-audit individual businesses more deeply later.">
                <div className="space-y-2">
                  {DEPTHS.map((d) => (
                    <button
                      key={d.value}
                      onClick={() => setDepth(d.value)}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                        depth === d.value ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                          depth === d.value ? 'border-accent' : 'border-border-strong',
                        )}
                      >
                        {depth === d.value && <span className="h-2 w-2 rounded-full bg-accent" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-[13px] font-medium">{d.title}</span>
                          <Badge tone="outline">{d.time}</Badge>
                        </span>
                        <span className="mt-0.5 block text-2xs leading-4 text-muted">{d.detail}</span>
                        <span className="mt-1 block text-2xs leading-4 text-subtle">{d.note}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </Step>
            )}

            {step === 5 && (
              <Step title="Review and start" hint="Discovery runs in the background — you can leave this page.">
                <dl className="divide-y divide-border rounded-lg border border-border">
                  <ReviewRow label="Location" value={[area, city, region, country, postalCode].filter(Boolean).join(', ') || '—'} />
                  <ReviewRow label="Radius" value={RADIUS_OPTIONS.find((r) => r.value === radius)?.label ?? `${radius} m`} />
                  <ReviewRow label="Industry" value={industry || '—'} />
                  <ReviewRow label="Keywords" value={keywords.length ? keywords.join(', ') : 'None'} />
                  <ReviewRow label="Exclusions" value={exclusions.length ? exclusions.join(', ') : 'None'} />
                  <ReviewRow label="Term expansion" value={expandTerms ? 'On' : 'Off'} />
                  <ReviewRow
                    label="Sources"
                    value={
                      selectedProviders
                        .map((id) => providers.find((p) => p.id === id)?.label ?? id)
                        .join(', ') || '—'
                    }
                  />
                  <ReviewRow label="Audit depth" value={depth} />
                </dl>

                {error && (
                  <div className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
                    {error}
                  </div>
                )}
              </Step>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <Button
              variant="ghost"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              disabled={step === 1}
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>

            {step < 5 ? (
              <Button
                variant="primary"
                onClick={() => setStep((s) => s + 1)}
                disabled={!canContinue}
              >
                Continue
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button variant="primary" onClick={submit} loading={submitting}>
                <Rocket className="h-3.5 w-3.5" />
                Start discovery
              </Button>
            )}
          </div>
        </Card>
      </div>

      {/* ── Live coverage / cost estimate (§33) ─────────────────────────── */}
      <aside className="space-y-4">
        <Card>
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-[13px] font-semibold">Estimated work</h3>
          </div>
          <dl className="space-y-2.5 px-4 py-3 text-[13px]">
            <EstRow label="Geographic cells" value={estimate.cells} />
            <EstRow label="Search terms" value={estimate.terms} />
            <EstRow label="Sources" value={selectedProviders.length} />
            <div className="border-t border-border pt-2.5">
              <EstRow label="Provider queries" value={estimate.queries} strong />
            </div>
          </dl>
          <p className="border-t border-border px-4 py-2.5 text-2xs leading-4 text-subtle">
            An estimate of queries, not of results — how many businesses exist in the area
            is not knowable in advance. The job reports actual coverage when it finishes.
          </p>
        </Card>

        <Card>
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-[13px] font-semibold">What happens next</h3>
          </div>
          <ol className="space-y-2.5 px-4 py-3 text-2xs leading-4 text-muted">
            {[
              'Location is geocoded and split into search cells',
              'Each source is queried for each term in each cell',
              'Results are normalised and deduplicated into one record per business',
              'Websites are detected and verified',
              'Each site is crawled, then SEO, speed, UX and technical checks run',
              'Opportunities and lead scores are computed from the evidence',
            ].map((s, i) => (
              <li key={s} className="flex gap-2.5">
                <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-muted">
                  {i + 1}
                </span>
                {s}
              </li>
            ))}
          </ol>
        </Card>
      </aside>
    </div>
  )
}

// ── small pieces ─────────────────────────────────────────────────────────────

function Stepper({ current, onJump }: { current: number; onJump: (s: number) => void }) {
  return (
    <ol className="flex items-center gap-1">
      {STEPS.map((s, i) => {
        const done = current > s.id
        const active = current === s.id
        const Icon = s.icon
        return (
          <li key={s.id} className="flex flex-1 items-center gap-1">
            <button
              onClick={() => onJump(s.id)}
              disabled={!done}
              className={cn(
                'flex flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                active && 'bg-accent-soft',
                done && 'hover:bg-surface-2',
              )}
            >
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold',
                  active ? 'bg-accent text-accent-fg'
                  : done ? 'bg-ok/15 text-ok'
                  : 'bg-surface-2 text-subtle',
                )}
              >
                {done ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
              </span>
              <span
                className={cn(
                  'hidden truncate text-2xs font-medium sm:block',
                  active ? 'text-accent' : done ? 'text-fg' : 'text-subtle',
                )}
              >
                {s.label}
              </span>
            </button>
            {i < STEPS.length - 1 && <span className="h-px w-3 shrink-0 bg-border" />}
          </li>
        )
      })}
    </ol>
  )
}

function Step({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-0.5 text-[13px] text-muted">{hint}</p>
      </div>
      {children}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  optional,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  optional?: boolean
}) {
  const id = label.toLowerCase().replace(/\W+/g, '-')
  return (
    <div>
      <Label htmlFor={id} hint={optional ? 'optional' : undefined}>
        {label}
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  )
}

function TagInput({
  label,
  hint,
  values,
  draft,
  setDraft,
  onAdd,
  onRemove,
  placeholder,
}: {
  label: string
  hint: string
  values: string[]
  draft: string
  setDraft: (v: string) => void
  onAdd: (v: string) => void
  onRemove: (i: number) => void
  placeholder: string
}) {
  function commit() {
    const v = draft.trim()
    if (!v || values.includes(v)) return
    onAdd(v)
    setDraft('')
  }

  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={placeholder}
        />
        <Button onClick={commit} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v, i) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-2xs"
            >
              {v}
              <button onClick={() => onRemove(i)} aria-label={`Remove ${v}`}>
                <X className="h-3 w-3 text-subtle hover:text-danger" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ state }: { state: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR' }) {
  if (state === 'CONNECTED') return <Badge tone="ok">Connected</Badge>
  if (state === 'ERROR') return <Badge tone="danger">Error</Badge>
  return <Badge tone="neutral">Not configured</Badge>
}

function Note({
  children,
  icon,
  tone = 'info',
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  tone?: 'info' | 'warn'
}) {
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-2xs leading-4',
        tone === 'warn'
          ? 'border-warn/30 bg-warn/10 text-warn'
          : 'border-border bg-surface-2 text-muted',
      )}
    >
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <span>{children}</span>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3.5 py-2.5">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="max-w-[60%] text-right text-[13px] font-medium">{value}</dd>
    </div>
  )
}

function EstRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className={cn('text-muted', strong && 'font-medium text-fg')}>{label}</dt>
      <dd className={cn('tnum', strong ? 'text-[15px] font-semibold' : 'font-medium')}>
        {value.toLocaleString()}
      </dd>
    </div>
  )
}
