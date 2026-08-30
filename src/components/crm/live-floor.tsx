'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Activity, PhoneCall, Radio, RefreshCw, Users } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Spinner } from '@/components/ui/primitives'
import { Avatar } from '@/components/crm/team-manager'
import { cn, formatNumber } from '@/lib/utils'

/**
 * The live floor.
 *
 * Polls rather than streams: one request every few seconds is cheaper to run
 * and cheaper to reason about than a socket that has to be reconnected, and the
 * question this page answers — who is working and on what — does not need
 * sub-second resolution.
 *
 * Polling pauses while the tab is hidden. A supervisor leaving this open on a
 * second monitor overnight should not generate 10,000 requests.
 */

const POLL_MS = 5_000

interface LiveAgentView {
  userId: string
  name: string
  email: string
  avatarPath: string | null
  status: 'online' | 'idle' | 'offline'
  lastSeenAt: string | null
  onLead: { id: string; name: string } | null
  clockedInAt: string | null
  shiftSeconds: number
  activeSeconds: number
  callsToday: number
  reachedToday: number
  lastCallAt: string | null
}

interface RecentCall {
  id: string
  outcome: string
  contactReached: boolean
  createdAt: string
  durationSec: number | null
  business: { id: string; name: string }
  user: { id: string; name: string | null; email: string }
}

interface LiveData {
  day: string
  timeZone: string
  agents: LiveAgentView[]
  recentCalls: RecentCall[]
  today: {
    calls: number
    reached: number
    contactRate: number | null
    online: number
    clockedIn: number
  }
  serverTime: string
}

const STATUS_TONE = {
  online: 'ok',
  idle: 'warn',
  offline: 'neutral',
} as const

const STATUS_DOT = {
  online: 'bg-ok',
  idle: 'bg-warn',
  offline: 'bg-subtle',
} as const

function duration(seconds: number): string {
  if (seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Relative time measured against the server's clock, not the browser's. */
function ago(iso: string | null, nowMs: number): string {
  if (!iso) return '—'
  const secs = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function outcomeLabel(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function LiveFloor() {
  const [data, setData] = useState<LiveData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await fetch('/api/crm/live?recent=15', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not load the floor')
        return
      }
      setData(json)
      setNowMs(new Date(json.serverTime).getTime())
      setError(null)
    } catch {
      setError('Could not reach the server')
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    void load()
    const onVisibility = () => setPaused(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    setPaused(document.hidden)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [load])

  useEffect(() => {
    if (paused) return
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [paused, load])

  // Advance the clock between polls so "14s ago" keeps counting.
  useEffect(() => {
    if (paused) return
    const id = setInterval(() => setNowMs((t) => t + 1000), 1000)
    return () => clearInterval(id)
  }, [paused])

  if (!data && !error) {
    return (
      <div className="flex items-center gap-2 py-16 text-[13px] text-muted">
        <Spinner className="h-4 w-4" />
        Loading the floor…
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            Live floor
            {!paused && !error && (
              <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-ok" aria-hidden="true" />
            )}
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            {data ? (
              <>
                Today is {data.day} in {data.timeZone}.{' '}
                {paused ? 'Paused while this tab is in the background.' : 'Refreshing every 5 seconds.'}
              </>
            ) : (
              'Live agent activity.'
            )}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-danger/40 p-3 text-[13px] text-danger">{error}</Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={<Radio className="h-4 w-4" />} label="Online now" value={data.today.online} />
            <Stat icon={<Users className="h-4 w-4" />} label="Clocked in" value={data.today.clockedIn} />
            <Stat icon={<PhoneCall className="h-4 w-4" />} label="Calls today" value={data.today.calls} />
            <Stat
              icon={<Activity className="h-4 w-4" />}
              label="Contact rate"
              value={data.today.contactRate}
              suffix="%"
              // A rate over zero calls is not 0% — it is unknown, and saying 0%
              // would read as a bad morning rather than an empty one.
              empty="No calls yet"
            />
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-[13px] font-semibold">Agents</h2>
            </div>
            {data.agents.length === 0 ? (
              <EmptyState
                icon={<Users className="h-5 w-5" />}
                title="Nobody on the team yet"
                description="Add agents from the Team page, then assign them leads to work."
                action={
                  <Link href="/team">
                    <Button variant="primary">Go to Team</Button>
                  </Link>
                }
              />
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-surface-2 text-2xs uppercase tracking-wide text-muted">
                    <th className="px-5 py-2.5 text-left font-semibold">Agent</th>
                    <th className="px-3 py-2.5 text-left font-semibold">Working on</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Calls</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Reached</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Active</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Shift</th>
                    <th className="px-5 py-2.5 text-right font-semibold">Last call</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((a) => (
                    <tr key={a.userId} className="border-b border-border last:border-0">
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <span className="relative">
                            <Avatar member={{ ...a, id: a.userId }} />
                            <span
                              aria-hidden="true"
                              className={cn(
                                'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface',
                                STATUS_DOT[a.status],
                              )}
                            />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium">{a.name}</div>
                            <div className="text-2xs text-subtle">
                              {a.status === 'offline'
                                ? a.lastSeenAt
                                  ? `Offline · seen ${ago(a.lastSeenAt, nowMs)}`
                                  : 'Has never signed in'
                                : a.clockedInAt
                                  ? `On shift since ${new Date(a.clockedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                                  : 'In the app, not clocked in'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {a.onLead ? (
                          <Link
                            href={`/businesses/${a.onLead.id}`}
                            className="truncate text-accent hover:underline"
                          >
                            {a.onLead.name}
                          </Link>
                        ) : (
                          <Badge tone={STATUS_TONE[a.status]}>
                            {a.status === 'online' ? 'Between calls' : a.status === 'idle' ? 'Idle' : 'Offline'}
                          </Badge>
                        )}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right font-medium">{a.callsToday}</td>
                      <td className="tnum px-3 py-2.5 text-right text-muted">{a.reachedToday}</td>
                      <td className="tnum px-3 py-2.5 text-right text-muted">
                        {duration(a.activeSeconds)}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right text-muted">
                        {a.clockedInAt ? duration(a.shiftSeconds) : '—'}
                      </td>
                      <td className="px-5 py-2.5 text-right text-muted">{ago(a.lastCallAt, nowMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-[13px] font-semibold">Latest calls</h2>
            </div>
            {data.recentCalls.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-muted">
                No calls logged today yet.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {data.recentCalls.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                    <Badge tone={c.contactReached ? 'ok' : 'neutral'}>
                      {outcomeLabel(c.outcome)}
                    </Badge>
                    <Link
                      href={`/businesses/${c.business.id}`}
                      className="min-w-0 flex-1 truncate hover:text-accent hover:underline"
                    >
                      {c.business.name}
                    </Link>
                    <span className="truncate text-muted">{c.user.name ?? c.user.email}</span>
                    {c.durationSec !== null && (
                      <span className="tnum shrink-0 text-2xs text-subtle">
                        {Math.floor(c.durationSec / 60)}:{String(c.durationSec % 60).padStart(2, '0')}
                      </span>
                    )}
                    <span className="shrink-0 text-2xs text-subtle">{ago(c.createdAt, nowMs)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
  suffix,
  empty,
}: {
  icon: React.ReactNode
  label: string
  value: number | null
  suffix?: string
  empty?: string
}) {
  return (
    <Card className="px-4 py-3">
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
        <span className="text-subtle">{icon}</span>
        {label}
      </div>
      <div className="tnum mt-1 text-2xl font-semibold leading-7">
        {value === null ? (
          <span className="text-[13px] font-normal text-subtle">{empty ?? '—'}</span>
        ) : (
          <>
            {formatNumber(value)}
            {suffix && <span className="text-base text-muted">{suffix}</span>}
          </>
        )}
      </div>
    </Card>
  )
}
