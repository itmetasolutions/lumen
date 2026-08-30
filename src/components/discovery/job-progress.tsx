'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  CheckCircle2, AlertTriangle, XCircle, Loader2, Clock, ArrowRight,
  RefreshCw, Copy,
} from 'lucide-react'
import { Badge, Button, Card, EmptyState, Skeleton } from '@/components/ui/primitives'
import { cn, formatDateTime, formatNumber, pct } from '@/lib/utils'

/**
 * Live discovery progress (§16).
 *
 * Polls rather than holding a socket open: the job is a background process that
 * may outlive the page, and a poll gives the same experience without a stateful
 * connection to manage. Polling stops as soon as the job reaches a terminal state.
 */

interface JobEvent {
  id: string
  stage: string
  level: string
  message: string
  createdAt: string
}

interface Job {
  id: string
  name: string
  state: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED'
  industry: string
  depth: string
  city: string | null
  region: string | null
  country: string | null
  providers: string[]
  sourcesSearched: string[]
  queriesExecuted: number
  cellsSearched: number
  cellsPlanned: number
  candidatesFound: number
  uniqueBusinesses: number
  duplicatesMerged: number
  newBusinesses: number
  errorCount: number
  progressStage: string | null
  progressPercent: number
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  error: string | null
  events: JobEvent[]
}

interface Payload {
  job: Job
  queryStats: Record<string, number>
  audits: { pending: number; done: number }
}

const TERMINAL = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'])

export function JobProgress({
  jobId,
  initialName,
}: {
  jobId: string
  initialName: string
}) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stopped = useRef(false)

  useEffect(() => {
    stopped.current = false
    let timer: ReturnType<typeof setTimeout>

    async function tick() {
      try {
        const res = await fetch(`/api/discovery/jobs/${jobId}`, { cache: 'no-store' })
        if (!res.ok) {
          setError((await res.json().catch(() => ({}))).error ?? 'Could not load the job')
        } else {
          const json: Payload = await res.json()
          setData(json)
          setError(null)

          // Keep polling while audits are still finishing, even after discovery
          // itself has completed — the numbers on screen are still changing.
          const jobDone = TERMINAL.has(json.job.state)
          const auditsDone = json.audits.pending === 0
          if (jobDone && auditsDone) {
            stopped.current = true
            return
          }
        }
      } catch {
        setError('Could not reach the server')
      }
      if (!stopped.current) timer = setTimeout(tick, 2000)
    }

    void tick()
    return () => {
      stopped.current = true
      clearTimeout(timer)
    }
  }, [jobId])

  if (error && !data) {
    return <EmptyState title="Could not load this job" description={error} />
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-2 w-full" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </div>
    )
  }

  const { job, queryStats, audits } = data
  const running = !TERMINAL.has(job.state)
  const auditTotal = audits.pending + audits.done

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {job.name || initialName}
            </h1>
            <StateBadge state={job.state} />
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {job.industry} ·{' '}
            {[job.city, job.region, job.country].filter(Boolean).join(', ') || 'Location'} ·{' '}
            {job.depth} audit · started {formatDateTime(job.startedAt ?? job.createdAt)}
          </p>
        </div>

        <div className="flex gap-2">
          <RerunButton jobId={job.id} mode="rerun" />
          <RerunButton jobId={job.id} mode="duplicate" />
          {job.uniqueBusinesses > 0 && (
            <Link href="/leads/all">
              <Button variant="primary" size="sm">
                View results
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* ── Progress bar ─────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4">
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 font-medium">
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
              {job.progressStage ?? 'Waiting to start'}
            </span>
            <span className="tnum text-muted">{job.progressPercent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-500',
                job.state === 'FAILED' ? 'bg-danger' : job.state === 'PARTIAL' ? 'bg-warn' : 'bg-accent',
              )}
              style={{ width: `${Math.max(2, job.progressPercent)}%` }}
            />
          </div>

          {auditTotal > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between text-[13px]">
                <span className="font-medium">Website audits</span>
                <span className="tnum text-muted">
                  {formatNumber(audits.done)} / {formatNumber(auditTotal)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-ok transition-[width] duration-500"
                  style={{ width: `${Math.max(2, pct(audits.done, auditTotal))}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* ── Coverage report (§2) ─────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Candidates found" value={job.candidatesFound} hint="Raw records returned by every source" />
        <Stat label="Unique businesses" value={job.uniqueBusinesses} hint="After entity resolution" tone="accent" />
        <Stat label="Duplicates merged" value={job.duplicatesMerged} hint="Matched to an existing record" />
        <Stat label="New businesses" value={job.newBusinesses} hint="First seen in this job" tone="ok" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* ── Event log ─────────────────────────────────────────────────── */}
        <Card>
          <div className="border-b border-border px-5 py-3">
            <h2 className="text-[13px] font-semibold">Activity</h2>
          </div>
          <ol className="max-h-[420px] divide-y divide-border overflow-y-auto">
            {job.events.length === 0 && (
              <li className="px-5 py-4 text-[13px] text-muted">
                Waiting for the worker to pick up this job. If nothing happens, check that{' '}
                <code className="rounded bg-surface-2 px-1">npm run worker</code> is running.
              </li>
            )}
            {[...job.events].reverse().map((e) => (
              <li key={e.id} className="flex gap-3 px-5 py-2.5">
                <span className="mt-0.5 shrink-0">
                  {e.level === 'error' ? (
                    <XCircle className="h-3.5 w-3.5 text-danger" />
                  ) : e.level === 'warn' ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-warn" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-5">{e.message}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-subtle">
                    <Clock className="h-3 w-3" />
                    {formatDateTime(e.createdAt)}
                    <Badge tone="outline">{e.stage}</Badge>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        {/* ── Coverage detail ───────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-[13px] font-semibold">Coverage</h2>
            </div>
            <dl className="space-y-2 px-4 py-3 text-[13px]">
              <Row label="Sources searched" value={job.sourcesSearched.join(', ') || '—'} />
              <Row label="Geographic cells" value={`${job.cellsSearched} / ${job.cellsPlanned}`} />
              <Row label="Queries executed" value={formatNumber(job.queriesExecuted)} />
              <Row label="Queries succeeded" value={formatNumber(queryStats.OK ?? 0)} />
              <Row
                label="Queries failed"
                value={formatNumber(queryStats.FAILED ?? 0)}
                tone={queryStats.FAILED ? 'danger' : undefined}
              />
              <Row
                label="Errors"
                value={formatNumber(job.errorCount)}
                tone={job.errorCount ? 'warn' : undefined}
              />
            </dl>
            <p className="border-t border-border px-4 py-2.5 text-2xs leading-4 text-subtle">
              Coverage describes what was actually searched. It is not a claim to have
              found every business in the area — no data source can support that.
            </p>
          </Card>

          {job.error && (
            <Card className="border-danger/30">
              <div className="px-4 py-3">
                <h2 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-danger">
                  <XCircle className="h-3.5 w-3.5" />
                  Job error
                </h2>
                <p className="text-2xs leading-4 text-muted">{job.error}</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function RerunButton({ jobId, mode }: { jobId: string; mode: 'rerun' | 'duplicate' }) {
  const [loading, setLoading] = useState(false)

  async function go() {
    setLoading(true)
    const res = await fetch(`/api/discovery/jobs/${jobId}/rerun?mode=${mode}`, {
      method: 'POST',
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok && json.id) window.location.href = `/discovery/jobs/${json.id}`
    else setLoading(false)
  }

  return (
    <Button variant="secondary" size="sm" onClick={go} loading={loading}>
      {mode === 'rerun' ? (
        <RefreshCw className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {mode === 'rerun' ? 'Re-run' : 'Duplicate'}
    </Button>
  )
}

function StateBadge({ state }: { state: Job['state'] }) {
  const map = {
    PENDING: ['neutral', 'Queued'],
    RUNNING: ['info', 'Running'],
    COMPLETED: ['ok', 'Completed'],
    PARTIAL: ['warn', 'Partial'],
    FAILED: ['danger', 'Failed'],
    CANCELLED: ['neutral', 'Cancelled'],
  } as const
  const [tone, label] = map[state]
  return <Badge tone={tone}>{label}</Badge>
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number
  hint: string
  tone?: 'accent' | 'ok'
}) {
  return (
    <Card>
      <div className="px-4 py-3">
        <div
          className={cn(
            'tnum text-2xl font-semibold tracking-tight',
            tone === 'accent' && 'text-accent',
            tone === 'ok' && 'text-ok',
          )}
        >
          {formatNumber(value)}
        </div>
        <div className="mt-0.5 text-[13px] font-medium">{label}</div>
        <div className="mt-0.5 text-2xs leading-4 text-subtle">{hint}</div>
      </div>
    </Card>
  )
}

function Row({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'danger' | 'warn'
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd
        className={cn(
          'tnum truncate font-medium',
          tone === 'danger' && 'text-danger',
          tone === 'warn' && 'text-warn',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
