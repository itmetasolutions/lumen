'use client'

import { CalendarDays, PhoneCall } from 'lucide-react'
import { Card, EmptyState } from '@/components/ui/primitives'
import { cn, formatNumber } from '@/lib/utils'

/**
 * An agent's own results.
 *
 * Shown to the person the numbers are about, so the framing matters: today is
 * progress, not a score, and the history is a record rather than a ranking.
 * There is no comparison against other agents here — that is the supervisor's
 * view, and putting it in front of the agent changes what the numbers are for.
 */

interface Totals {
  calls: number
  reached: number
  leadsWorked: number
  followUpsSet: number
  meetingsBooked: number
  sales: number
  interested: number
  activeMinutes: number
  shiftMinutes: number
  contactRate: number | null
}

interface HistoryRow {
  day: string
  calls: number
  reached: number
  leadsWorked: number
  meetingsBooked: number
  sales: number
  activeMinutes: number
  shiftMinutes: number
  contactRate: number | null
  callsPerHour: number | null
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function AgentResults({
  today,
  timeZone,
  live,
  history,
}: {
  today: string
  timeZone: string
  live: Totals
  history: HistoryRow[]
}) {
  const best = history.reduce((max, r) => Math.max(max, r.calls), live.calls || 1)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">My results</h1>
        <p className="mt-1 text-[13px] text-muted">
          Today so far, and the last 30 days. Days are counted in {timeZone}.
        </p>
      </div>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">
            Today
            <span className="ml-2 font-normal text-subtle">{today}</span>
          </h2>
          {live.shiftMinutes > 0 && (
            <span className="text-2xs text-subtle">
              {hhmm(live.activeMinutes)} active of {hhmm(live.shiftMinutes)} on shift
            </span>
          )}
        </div>

        {live.calls === 0 ? (
          <p className="py-4 text-center text-[13px] text-muted">
            No calls logged yet today. Open your queue to get started.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Big label="Calls" value={formatNumber(live.calls)} />
            <Big label="Reached" value={formatNumber(live.reached)} />
            <Big
              label="Contact rate"
              value={live.contactRate === null ? null : `${live.contactRate}%`}
            />
            <Big label="Leads worked" value={formatNumber(live.leadsWorked)} />
            <Big label="Meetings" value={formatNumber(live.meetingsBooked)} accent={live.meetingsBooked > 0} />
            <Big label="Sales" value={formatNumber(live.sales)} accent={live.sales > 0} />
          </div>
        )}
      </Card>

      {history.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarDays className="h-5 w-5" />}
            title="No earlier days yet"
            description="Your day is written up automatically each evening. Once you have worked a full day, it will appear here."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-5 py-3">
            <h2 className="text-[13px] font-semibold">Previous days</h2>
          </div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-2xs uppercase tracking-wide text-muted">
                <th className="px-5 py-2 text-left font-semibold">Day</th>
                <th className="px-2 py-2 text-left font-semibold">Calls</th>
                <th className="px-2 py-2 text-right font-semibold">Reached</th>
                <th className="px-2 py-2 text-right font-semibold">Rate</th>
                <th className="px-2 py-2 text-right font-semibold">Meetings</th>
                <th className="px-2 py-2 text-right font-semibold">Sales</th>
                <th className="px-5 py-2 text-right font-semibold">Active</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.day} className="border-b border-border last:border-0">
                  <td className="px-5 py-2.5">
                    {new Date(`${r.day}T12:00:00`).toLocaleDateString(undefined, {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                    })}
                  </td>
                  <td className="px-2 py-2.5">
                    {/* A bar beside the number turns a column of digits into a
                        shape the agent can read at a glance. */}
                    <div className="flex items-center gap-2">
                      <span className="tnum w-8 font-medium">{r.calls}</span>
                      <span className="h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-surface-2">
                        <span
                          className="block h-full rounded-full bg-accent"
                          style={{ width: `${Math.round((r.calls / best) * 100)}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className="tnum px-2 py-2.5 text-right text-muted">{r.reached}</td>
                  <td className="tnum px-2 py-2.5 text-right">
                    {r.contactRate === null ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      `${r.contactRate}%`
                    )}
                  </td>
                  <td className="tnum px-2 py-2.5 text-right">
                    <span className={cn(r.meetingsBooked > 0 && 'font-medium text-ok')}>
                      {r.meetingsBooked}
                    </span>
                  </td>
                  <td className="tnum px-2 py-2.5 text-right">
                    <span className={cn(r.sales > 0 && 'font-semibold text-ok')}>{r.sales}</span>
                  </td>
                  <td className="tnum px-5 py-2.5 text-right text-muted">
                    {hhmm(r.activeMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="flex items-start gap-1.5 text-2xs text-subtle">
        <PhoneCall className="mt-0.5 h-3 w-3 shrink-0" />
        &ldquo;Reached&rdquo; counts calls where you actually spoke to someone at
        the business. Voicemail and no-answer are recorded, but do not count as
        contact.
      </p>
    </div>
  )
}

function Big({
  label,
  value,
  accent,
}: {
  label: string
  value: string | null
  accent?: boolean
}) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-subtle">{label}</div>
      <div className={cn('tnum mt-0.5 text-2xl font-semibold leading-7', accent && 'text-ok')}>
        {value ?? <span className="text-[13px] font-normal text-subtle">—</span>}
      </div>
    </div>
  )
}
