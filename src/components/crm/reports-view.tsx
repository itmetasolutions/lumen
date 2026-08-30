'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, RefreshCw, TrendingUp } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Input, Select } from '@/components/ui/primitives'
import { Avatar } from '@/components/crm/team-manager'
import { formatNumber } from '@/lib/utils'

/**
 * Daily reports.
 *
 * Two numbers on this page need care, and both are deliberately allowed to be
 * absent rather than zero:
 *
 * - **Contact rate** over no calls is unknown, not 0%. Showing 0% would read as
 *   a terrible day rather than an empty one.
 * - **Calls per hour** over no recorded active time is likewise unknown. An
 *   agent who logged calls without clocking in has real calls and no rate.
 *
 * The roll-up button exists because the day is a snapshot: a supervisor who
 * wants today's numbers before the automatic end-of-day pass can take them now.
 */

export interface ReportRowView {
  userId: string
  name: string
  email: string
  avatarPath: string | null
  day: string
  calls: number
  reached: number
  leadsWorked: number
  followUpsSet: number
  meetingsBooked: number
  sales: number
  interested: number
  notInterested: number
  doNotCall: number
  activeMinutes: number
  shiftMinutes: number
  firstActivityAt: string | null
  lastActivityAt: string | null
  outcomes: Record<string, number>
  contactRate: number | null
  callsPerHour: number | null
}

interface Summary {
  calls: number
  reached: number
  leadsWorked: number
  meetingsBooked: number
  sales: number
  interested: number
  activeMinutes: number
  shiftMinutes: number
  agents: number
  days: number
  contactRate: number | null
  callsPerHour: number | null
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function clockTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ReportsView({
  initialRows,
  initialSummary,
  from,
  to,
  today,
  timeZone,
  selectedUserId,
  agents,
}: {
  initialRows: ReportRowView[]
  initialSummary: Summary
  from: string
  to: string
  today: string
  timeZone: string
  selectedUserId: string | null
  agents: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rollingUp, setRollingUp] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [rows, setRows] = useState(initialRows)
  const [summary, setSummary] = useState(initialSummary)

  // A navigation re-renders this component with fresh props; adopt them.
  useEffect(() => {
    setRows(initialRows)
    setSummary(initialSummary)
  }, [initialRows, initialSummary])

  function navigate(next: { from?: string; to?: string; userId?: string | null }) {
    const params = new URLSearchParams()
    params.set('from', next.from ?? from)
    params.set('to', next.to ?? to)
    const user = next.userId === undefined ? selectedUserId : next.userId
    if (user) params.set('userId', user)
    startTransition(() => router.push(`/reports?${params.toString()}`))
  }

  async function reload() {
    const params = new URLSearchParams({ from, to })
    if (selectedUserId) params.set('userId', selectedUserId)
    const res = await fetch(`/api/crm/reports?${params}`, { cache: 'no-store' })
    if (!res.ok) return
    const json = await res.json()
    setRows(json.rows)
    setSummary(json.summary)
  }

  async function rollUpToday() {
    setRollingUp(true)
    setNotice(null)
    try {
      const res = await fetch('/api/crm/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'generate-day', day: today }),
      })
      const json = await res.json()
      if (!res.ok) {
        setNotice(json.error ?? 'Could not generate reports')
        return
      }
      setNotice(
        json.generated === 0
          ? 'Nobody has logged work today yet, so there was nothing to roll up.'
          : `Rolled up ${json.generated} report${json.generated === 1 ? '' : 's'} for ${today}.`,
      )
      // Read the day back rather than waiting for a navigation, so the numbers
      // the message refers to are actually on screen.
      if (json.generated > 0) await reload()
      router.refresh()
    } catch {
      setNotice('Could not reach the server')
    } finally {
      setRollingUp(false)
    }
  }

  // Group by day so the table reads as a diary rather than a flat list.
  const byDay = new Map<string, ReportRowView[]>()
  for (const row of rows) {
    const list = byDay.get(row.day) ?? []
    list.push(row)
    byDay.set(row.day, list)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
          <p className="mt-1 max-w-3xl text-[13px] text-muted">
            Each day is rolled up once and stored, so past numbers never change
            underneath you. Days close automatically in the evening
            ({timeZone}); the button rolls today up early.
          </p>
        </div>
        <Button variant="secondary" loading={rollingUp} onClick={() => void rollUpToday()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Roll up today
        </Button>
      </div>

      {notice && (
        <Card className="border-accent/40 bg-accent-soft/30 px-4 py-2.5 text-[13px]">{notice}</Card>
      )}

      <Card className="flex flex-wrap items-end gap-3 px-4 py-3">
        <div>
          <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-subtle">
            From
          </label>
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(e) => navigate({ from: e.target.value })}
            className="w-[150px]"
          />
        </div>
        <div>
          <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-subtle">
            To
          </label>
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => navigate({ to: e.target.value })}
            className="w-[150px]"
          />
        </div>
        <div>
          <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-subtle">
            Agent
          </label>
          <Select
            value={selectedUserId ?? ''}
            onChange={(e) => navigate({ userId: e.target.value || null })}
            className="w-[190px]"
          >
            <option value="">Everyone</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        {pending && <span className="pb-2 text-[13px] text-muted">Loading…</span>}
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Calls" value={formatNumber(summary.calls)} />
        <Stat label="Reached" value={formatNumber(summary.reached)} />
        <Stat
          label="Contact rate"
          value={summary.contactRate === null ? null : `${summary.contactRate}%`}
        />
        <Stat label="Meetings" value={formatNumber(summary.meetingsBooked)} />
        <Stat label="Sales" value={formatNumber(summary.sales)} />
        <Stat label="Active time" value={hhmm(summary.activeMinutes)} />
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarClock className="h-5 w-5" />}
            title="No reports in this range"
            description="Reports appear once agents log calls and the day is rolled up. Nothing was recorded between these dates."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {[...byDay.entries()].map(([day, rows]) => (
            <Card key={day} className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-border bg-surface-2 px-5 py-2.5">
                <h2 className="text-[13px] font-semibold">
                  {new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                  {day === today && (
                    <Badge tone="accent" className="ml-2">
                      Today
                    </Badge>
                  )}
                </h2>
                <span className="tnum text-2xs text-subtle">
                  {(() => {
                    const total = rows.reduce((n, r) => n + r.calls, 0)
                    return `${formatNumber(total)} call${total === 1 ? '' : 's'}`
                  })()}{' '}
                  · {rows.length} agent{rows.length === 1 ? '' : 's'}
                </span>
              </div>

              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted">
                    <th className="px-5 py-2 text-left font-semibold">Agent</th>
                    <th className="px-2 py-2 text-right font-semibold">Calls</th>
                    <th className="px-2 py-2 text-right font-semibold">Reached</th>
                    <th className="px-2 py-2 text-right font-semibold">Rate</th>
                    <th className="px-2 py-2 text-right font-semibold">Leads</th>
                    <th className="px-2 py-2 text-right font-semibold">Follow-ups</th>
                    <th className="px-2 py-2 text-right font-semibold">Meetings</th>
                    <th className="px-2 py-2 text-right font-semibold">Sales</th>
                    <th className="px-2 py-2 text-right font-semibold">Calls/hr</th>
                    <th className="px-2 py-2 text-right font-semibold">Active</th>
                    <th className="px-5 py-2 text-right font-semibold">Window</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.day}-${r.userId}`} className="border-b border-border last:border-0">
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar member={{ ...r, id: r.userId }} size={24} />
                          <span className="truncate font-medium">{r.name}</span>
                        </div>
                      </td>
                      <td className="tnum px-2 py-2.5 text-right font-medium">{r.calls}</td>
                      <td className="tnum px-2 py-2.5 text-right text-muted">{r.reached}</td>
                      <td className="tnum px-2 py-2.5 text-right">
                        {r.contactRate === null ? (
                          <span className="text-subtle">—</span>
                        ) : (
                          <span className={r.contactRate >= 30 ? 'text-ok' : undefined}>
                            {r.contactRate}%
                          </span>
                        )}
                      </td>
                      <td className="tnum px-2 py-2.5 text-right text-muted">{r.leadsWorked}</td>
                      <td className="tnum px-2 py-2.5 text-right text-muted">{r.followUpsSet}</td>
                      <td className="tnum px-2 py-2.5 text-right">
                        {r.meetingsBooked > 0 ? (
                          <span className="font-medium text-ok">{r.meetingsBooked}</span>
                        ) : (
                          <span className="text-subtle">0</span>
                        )}
                      </td>
                      <td className="tnum px-2 py-2.5 text-right">
                        {r.sales > 0 ? (
                          <span className="font-semibold text-ok">{r.sales}</span>
                        ) : (
                          <span className="text-subtle">0</span>
                        )}
                      </td>
                      <td className="tnum px-2 py-2.5 text-right text-muted">
                        {r.callsPerHour === null ? '—' : r.callsPerHour}
                      </td>
                      <td className="tnum px-2 py-2.5 text-right text-muted">
                        {hhmm(r.activeMinutes)}
                        {r.shiftMinutes > r.activeMinutes && (
                          <span
                            className="text-subtle"
                            title={`On shift for ${hhmm(r.shiftMinutes)}`}
                          >
                            {' '}/ {hhmm(r.shiftMinutes)}
                          </span>
                        )}
                      </td>
                      <td className="tnum px-5 py-2.5 text-right text-2xs text-subtle">
                        {clockTime(r.firstActivityAt)} – {clockTime(r.lastActivityAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}

      <p className="flex items-start gap-1.5 text-2xs text-subtle">
        <TrendingUp className="mt-0.5 h-3 w-3 shrink-0" />
        Active time only accrues while the agent app is open and being used;
        shift time is the full span from clock-in to clock-out. A dash means the
        number is unknown rather than zero.
      </p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-2xs font-semibold uppercase tracking-wider text-subtle">{label}</div>
      <div className="tnum mt-1 text-xl font-semibold leading-6">
        {value ?? <span className="text-[13px] font-normal text-subtle">—</span>}
      </div>
    </Card>
  )
}
