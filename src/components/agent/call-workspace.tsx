'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlarmClock, ArrowLeft, ArrowRight, Building2, CheckCircle2, ExternalLink,
  Globe, Mail, MapPin, Share2, Star, Timer,
} from 'lucide-react'
import {
  Badge, Button, Card, Label, Textarea,
} from '@/components/ui/primitives'
import { CopyValue, PhoneValue } from '@/components/crm/copy-value'
import { cn, formatNumber, NOT_FOUND } from '@/lib/utils'

/**
 * The call workspace.
 *
 * Everything an agent needs on one screen, laid out around the one action that
 * matters: the number, then the disposition. The rules the server enforces are
 * mirrored here as *guidance* rather than duplicated as logic — the follow-up
 * field appears and is marked required because the outcome says so, and the
 * server refuses the save if it is missing anyway. The UI never decides.
 *
 * Handling time starts when the screen opens, not when the agent presses
 * something, and is sent with the call. A stale tab is clamped server-side.
 */

interface OutcomeOption {
  value: string
  label: string
  reached: boolean
  followUp: 'required' | 'optional' | 'forbidden'
  terminal: boolean
  positive: boolean
  tone: 'neutral' | 'info' | 'ok' | 'warn' | 'danger'
  hint: string
}

interface LeadView {
  id: string
  name: string
  primaryPhone: string | null
  primaryEmail: string | null
  websiteUrl: string | null
  addressLine: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  category: string | null
  categories: string[]
  rating: number | null
  reviewCount: number | null
  leadScore: number | null
  callCount: number
  nextFollowUpAt: string | null
  lastCallOutcome: string | null
  isDemo: boolean
  needsWebsite: boolean
  needsRedesign: boolean
  needsSeo: boolean
  needsSpeed: boolean
  stage: string | null
  contacts: Array<{
    id: string
    kind: 'PHONE' | 'EMAIL' | 'SOCIAL'
    value: string
    label: string | null
    isPrimary: boolean
    provider: string
  }>
  calls: Array<{
    id: string
    outcome: string
    contactReached: boolean
    notes: string | null
    durationSec: number | null
    followUpAt: string | null
    createdAt: string
    by: string
  }>
}

/** Quick follow-up presets, expressed the way an agent would say them. */
const PRESETS = [
  { label: 'In 1 hour', minutes: 60 },
  { label: 'This afternoon', minutes: 4 * 60 },
  { label: 'Tomorrow 10am', at: 'tomorrow-10' },
  { label: 'In 3 days', minutes: 3 * 24 * 60 },
  { label: 'Next week', minutes: 7 * 24 * 60 },
] as const

function presetDate(preset: (typeof PRESETS)[number]): Date {
  if ('at' in preset && preset.at === 'tomorrow-10') {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(10, 0, 0, 0)
    return d
  }
  return new Date(Date.now() + ('minutes' in preset ? preset.minutes : 60) * 60_000)
}

/** `datetime-local` wants a local-time string with no zone suffix. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function elapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function CallWorkspace({
  lead,
  outcomes,
  requireClockIn,
  clockedIn,
  nextLeadId,
}: {
  lead: LeadView
  outcomes: OutcomeOption[]
  requireClockIn: boolean
  clockedIn: boolean
  nextLeadId: string | null
}) {
  const router = useRouter()
  const openedAt = useRef(new Date())
  const [seconds, setSeconds] = useState(0)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ closed: boolean } | null>(null)

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const selected = useMemo(
    () => outcomes.find((o) => o.value === outcome) ?? null,
    [outcome, outcomes],
  )

  // Choosing an outcome that needs a follow-up pre-fills a sensible time, so the
  // common path is one click rather than a date picker.
  useEffect(() => {
    if (!selected) return
    if (selected.followUp === 'forbidden') { setFollowUp(''); return }
    if (selected.followUp === 'required' && !followUp) {
      setFollowUp(toLocalInput(presetDate(PRESETS[2])))
    }
    // `followUp` is intentionally excluded: this should only fire on a change of
    // outcome, not every time the agent edits the date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const blockedByClock = requireClockIn && !clockedIn
  const needsFollowUp = selected?.followUp === 'required' && !followUp
  const canSave = Boolean(selected) && !needsFollowUp && !blockedByClock && !saving

  async function save() {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/calls', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          businessId: lead.id,
          outcome: selected.value,
          phoneUsed: lead.primaryPhone,
          notes: notes.trim() || null,
          startedAt: openedAt.current.toISOString(),
          followUpAt:
            selected.followUp === 'forbidden' || !followUp
              ? null
              : new Date(followUp).toISOString(),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not save this call')
        return
      }
      setSaved({ closed: Boolean(json.closed) })
      router.refresh()
    } catch {
      setError('Could not reach the server. Your call has not been saved — try again.')
    } finally {
      setSaving(false)
    }
  }

  const phones = lead.contacts.filter((c) => c.kind === 'PHONE')
  const emails = lead.contacts.filter((c) => c.kind === 'EMAIL')
  const socials = lead.contacts.filter((c) => c.kind === 'SOCIAL')

  const address = [lead.addressLine, lead.city, lead.region, lead.postalCode, lead.country]
    .filter(Boolean)
    .join(', ')

  const opportunities = [
    lead.needsWebsite && 'No website',
    lead.needsRedesign && 'Needs redesign',
    lead.needsSeo && 'SEO gaps',
    lead.needsSpeed && 'Slow site',
  ].filter(Boolean) as string[]

  if (saved) {
    return (
      <SavedPanel
        closed={saved.closed}
        leadName={lead.name}
        nextLeadId={nextLeadId}
        onLogAnother={() => {
          setSaved(null)
          setOutcome(null)
          setNotes('')
          setFollowUp('')
          openedAt.current = new Date()
          setSeconds(0)
        }}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/agent"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to my queue
        </Link>
        <span className="inline-flex items-center gap-1.5 text-2xs text-subtle">
          <Timer className="h-3.5 w-3.5" />
          On this lead <span className="tnum font-medium">{elapsed(seconds)}</span>
        </span>
      </div>

      {blockedByClock && (
        <Card className="border-warn/40 bg-warn/10 px-4 py-3 text-[13px]">
          You are not clocked in. Start your shift from the top bar before
          logging calls — otherwise your work would not appear in your day&apos;s
          results.
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        {/* ── The business ──────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold leading-6">{lead.name}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-subtle">
                  {lead.category && (
                    <span className="inline-flex items-center gap-1">
                      <Building2 className="h-3 w-3" />
                      {lead.category}
                    </span>
                  )}
                  {lead.rating !== null && (
                    <span className="inline-flex items-center gap-1">
                      <Star className="h-3 w-3" />
                      {lead.rating.toFixed(1)}
                      {lead.reviewCount !== null && ` (${formatNumber(lead.reviewCount)})`}
                    </span>
                  )}
                  {lead.callCount > 0 && (
                    <span>
                      {lead.callCount} previous call{lead.callCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {lead.isDemo && <Badge tone="demo">DEMO DATA</Badge>}
                {lead.leadScore !== null && (
                  <Badge tone="accent" title="Lead score from this workspace's audit">
                    Score {lead.leadScore}
                  </Badge>
                )}
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-border bg-surface-2 px-4 py-3">
              <div className="text-2xs font-semibold uppercase tracking-wider text-subtle">
                Call this number
              </div>
              <div className="mt-1">
                <PhoneValue phone={lead.primaryPhone} size="lg" />
              </div>
              {phones.length > 1 && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2">
                  {phones
                    .filter((p) => p.value !== lead.primaryPhone)
                    .map((p) => (
                      <span key={p.id} className="inline-flex items-center gap-1.5 text-[13px]">
                        <PhoneValue phone={p.value} size="sm" showDial={false} />
                        {p.label && <span className="text-2xs text-subtle">{p.label}</span>}
                      </span>
                    ))}
                </div>
              )}
            </div>

            <dl className="mt-4 space-y-2.5 text-[13px]">
              <Row icon={<MapPin className="h-3.5 w-3.5" />} label="Address">
                {address ? <CopyValue value={address} /> : <span className="text-subtle">{NOT_FOUND}</span>}
              </Row>
              <Row icon={<Globe className="h-3.5 w-3.5" />} label="Website">
                {lead.websiteUrl ? (
                  <a
                    href={lead.websiteUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    {lead.websiteUrl.replace(/^https?:\/\//, '')}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-subtle">
                    {NOT_FOUND}
                    {lead.needsWebsite && (
                      <Badge tone="accent" className="ml-2">
                        Opportunity
                      </Badge>
                    )}
                  </span>
                )}
              </Row>
              <Row icon={<Mail className="h-3.5 w-3.5" />} label="Email">
                {emails.length > 0 ? (
                  <span className="flex flex-wrap gap-x-3">
                    {emails.map((e) => (
                      <CopyValue key={e.id} value={e.value} />
                    ))}
                  </span>
                ) : (
                  <span className="text-subtle">{NOT_FOUND}</span>
                )}
              </Row>
              {socials.length > 0 && (
                <Row icon={<Share2 className="h-3.5 w-3.5" />} label="Social">
                  <span className="flex flex-wrap gap-x-3">
                    {socials.map((s) => (
                      <a
                        key={s.id}
                        href={s.value}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-accent hover:underline"
                      >
                        {s.label ?? new URL(s.value).hostname.replace('www.', '')}
                      </a>
                    ))}
                  </span>
                </Row>
              )}
            </dl>

            {opportunities.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
                  What to talk about
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {opportunities.map((o) => (
                    <Badge key={o} tone="accent">
                      {o}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {lead.calls.length > 0 && (
            <Card className="overflow-hidden">
              <div className="border-b border-border px-5 py-3">
                <h2 className="text-[13px] font-semibold">Call history</h2>
              </div>
              <ul className="divide-y divide-border">
                {lead.calls.map((c) => {
                  const meta = outcomes.find((o) => o.value === c.outcome)
                  return (
                    <li key={c.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-[13px]">
                        <Badge tone={meta?.tone ?? 'neutral'}>{meta?.label ?? c.outcome}</Badge>
                        <span className="text-muted">{c.by}</span>
                        <span className="text-2xs text-subtle">
                          {new Date(c.createdAt).toLocaleString([], {
                            day: 'numeric', month: 'short',
                            hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                        {c.durationSec !== null && (
                          <span className="tnum text-2xs text-subtle">
                            {elapsed(c.durationSec)}
                          </span>
                        )}
                        {c.followUpAt && (
                          <span className="inline-flex items-center gap-1 text-2xs text-subtle">
                            <AlarmClock className="h-3 w-3" />
                            {new Date(c.followUpAt).toLocaleString([], {
                              day: 'numeric', month: 'short',
                              hour: '2-digit', minute: '2-digit',
                            })}
                          </span>
                        )}
                      </div>
                      {c.notes && (
                        <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-5 text-muted">
                          {c.notes}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}
        </div>

        {/* ── The disposition ───────────────────────────────────────────── */}
        <div className="lg:sticky lg:top-[72px] lg:self-start">
          <Card className="p-5">
            <h2 className="text-[13px] font-semibold">How did the call go?</h2>
            <p className="mt-0.5 text-2xs text-subtle">
              Every call is recorded and cannot be edited afterwards. Correct a
              mistake by logging another call with a note.
            </p>

            <div className="mt-3 grid grid-cols-2 gap-1.5">
              {outcomes.map((o) => {
                const active = outcome === o.value
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setOutcome(o.value)}
                    className={cn(
                      'rounded-lg border px-2.5 py-2 text-left text-[13px] transition-colors',
                      active
                        ? 'border-accent bg-accent-soft font-semibold text-accent'
                        : 'border-border text-muted hover:bg-surface-2 hover:text-fg',
                      o.value === 'DO_NOT_CALL' && !active && 'border-danger/30 text-danger',
                    )}
                  >
                    {o.label}
                  </button>
                )
              })}
            </div>

            {selected && (
              <p className="mt-2.5 rounded-lg bg-surface-2 px-3 py-2 text-2xs leading-4 text-muted">
                {selected.hint}
              </p>
            )}

            {selected && selected.followUp !== 'forbidden' && (
              <div className="mt-4">
                <Label htmlFor="follow-up">
                  Follow-up
                  {selected.followUp === 'required' ? (
                    <span className="ml-1 text-danger">required</span>
                  ) : (
                    <span className="ml-1 font-normal text-subtle">optional</span>
                  )}
                </Label>
                <input
                  id="follow-up"
                  type="datetime-local"
                  value={followUp}
                  min={toLocalInput(new Date())}
                  onChange={(e) => setFollowUp(e.target.value)}
                  className={cn(
                    'h-9 w-full rounded-lg border bg-surface px-2.5 text-[13px] outline-none',
                    'focus-visible:ring-2 focus-visible:ring-accent/40',
                    needsFollowUp ? 'border-danger' : 'border-border',
                  )}
                />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setFollowUp(toLocalInput(presetDate(p)))}
                      className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                    >
                      {p.label}
                    </button>
                  ))}
                  {followUp && selected.followUp === 'optional' && (
                    <button
                      type="button"
                      onClick={() => setFollowUp('')}
                      className="rounded border border-border px-1.5 py-0.5 text-2xs text-subtle hover:text-danger"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="mt-4">
              <Label htmlFor="call-notes">Notes</Label>
              <Textarea
                id="call-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Who you spoke to, what they said, what happens next."
              />
            </div>

            {error && (
              <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
                {error}
              </p>
            )}

            <Button
              variant="primary"
              className="mt-4 w-full justify-center"
              loading={saving}
              disabled={!canSave}
              onClick={() => void save()}
            >
              Save call
            </Button>

            {needsFollowUp && (
              <p className="mt-2 text-center text-2xs text-danger">
                Set a follow-up time before saving this outcome.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-subtle">{icon}</span>
      <dt className="w-20 shrink-0 text-2xs uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}

function SavedPanel({
  closed,
  leadName,
  nextLeadId,
  onLogAnother,
}: {
  closed: boolean
  leadName: string
  nextLeadId: string | null
  onLogAnother: () => void
}) {
  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <span className="mx-auto mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full bg-ok/15 text-ok">
        <CheckCircle2 className="h-5 w-5" />
      </span>
      <h2 className="text-sm font-semibold">Call saved</h2>
      <p className="mx-auto mt-1 max-w-sm text-[13px] leading-5 text-muted">
        {closed
          ? `${leadName} is closed and has left your queue. The record stays with the lead.`
          : `Your call on ${leadName} is recorded and counts toward today's results.`}
      </p>

      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {nextLeadId && (
          <Link href={`/agent/lead/${nextLeadId}`}>
            <Button variant="primary">
              Next lead
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        )}
        <Link href="/agent">
          <Button variant="secondary">Back to my queue</Button>
        </Link>
        {!closed && (
          <Button variant="ghost" onClick={onLogAnother}>
            Log another call on this lead
          </Button>
        )}
      </div>
    </Card>
  )
}
