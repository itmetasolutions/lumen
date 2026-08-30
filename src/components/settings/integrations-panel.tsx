'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import {
  RefreshCw, CheckCircle2, XCircle, MinusCircle, ExternalLink,
  Database, Chrome, HardDrive, Cpu,
} from 'lucide-react'
import { Badge, Button, Card, CardHeader, Skeleton } from '@/components/ui/primitives'
import { formatNumber } from '@/lib/utils'

/**
 * Settings → Integrations (§20).
 *
 * Every row is a live probe, not a "key is set" checkbox: a present-but-invalid
 * key is worse than a missing one, because it fails silently inside a job.
 *
 * No secret values are shown or transmitted — only status and a reason.
 */

interface Status {
  state: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'
  detail: string
}

interface Payload {
  discovery: Array<{
    id: string
    label: string
    description: string
    isDemo: boolean
    termsUrl?: string
    status: Status
  }>
  performance: Array<{ id: string; label: string; isDemo: boolean; status: Status }>
  ai: { id: string; isDemo: boolean; state: Status['state']; detail: string }
  storage: { id: string; detail: string }
  browser: Status
  queue: { driver: string; queues: Array<{ queue: string; counts: Record<string, number> }> }
}

export function IntegrationsPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/integrations', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Could not probe integrations')
      else setData(json)
    } catch {
      setError('Could not reach the server')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  if (loading && !data) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    )
  }

  if (error && !data) {
    return (
      <Card className="px-5 py-4 text-[13px] text-danger">
        {error}
        <Button className="ml-3" size="sm" onClick={load}>Retry</Button>
      </Card>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          <RefreshCw className="h-3.5 w-3.5" />
          Re-probe all
        </Button>
      </div>

      <Card>
        <CardHeader
          title="Discovery providers"
          description="Sources for finding businesses. At least one must be connected."
        />
        <ul className="divide-y divide-border">
          {data.discovery.map((p) => (
            <li key={p.id} className="px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <StateIcon state={p.status.state} />
                <span className="text-[13px] font-semibold">{p.label}</span>
                <StateBadge state={p.status.state} />
                {p.isDemo && <Badge tone="demo">DEMO DATA</Badge>}
                {p.termsUrl && (
                  <a
                    href={p.termsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-2xs text-accent hover:underline"
                  >
                    Terms
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
              <p className="mt-1 text-[13px] leading-5 text-muted">{p.description}</p>
              <p
                className={`mt-1 text-2xs leading-4 ${
                  p.status.state === 'CONNECTED' ? 'text-subtle' : 'text-warn'
                }`}
              >
                {p.status.detail}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Performance providers"
          description="Used for the Speed tab. Mobile and desktop are measured separately."
        />
        <ul className="divide-y divide-border">
          {data.performance.map((p) => (
            <li key={p.id} className="flex items-start gap-3 px-5 py-3.5">
              <StateIcon state={p.status.state} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">{p.label}</span>
                  <StateBadge state={p.status.state} />
                  {p.isDemo && <Badge tone="demo">DEMO DATA</Badge>}
                </div>
                <p className="mt-1 text-2xs leading-4 text-muted">{p.status.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="Browser (UX audits)" />
          <div className="flex items-start gap-3 px-5 py-4">
            <Chrome className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
            <div className="min-w-0">
              <StateBadge state={data.browser.state} />
              <p className="mt-1.5 text-2xs leading-4 text-muted">{data.browser.detail}</p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="AI-assisted UX" />
          <div className="flex items-start gap-3 px-5 py-4">
            <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StateBadge state={data.ai.state} />
                {data.ai.isDemo && <Badge tone="neutral">not configured</Badge>}
              </div>
              <p className="mt-1.5 text-2xs leading-4 text-muted">{data.ai.detail}</p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Storage" />
          <div className="flex items-start gap-3 px-5 py-4">
            <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
            <div className="min-w-0">
              <Badge tone="outline">{data.storage.id}</Badge>
              <p className="mt-1.5 break-all text-2xs leading-4 text-muted">
                {data.storage.detail}
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Job queue" />
          <div className="flex items-start gap-3 px-5 py-4">
            <Database className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
            <div className="min-w-0 flex-1">
              <Badge tone="outline">driver: {data.queue.driver}</Badge>
              <ul className="mt-2 space-y-1.5">
                {data.queue.queues.map((q) => (
                  <li key={q.queue} className="text-2xs">
                    <span className="font-medium">{q.queue}</span>
                    <span className="ml-2 text-muted">
                      {Object.entries(q.counts)
                        .filter(([, n]) => n > 0)
                        .map(([state, n]) => `${state.toLowerCase()} ${formatNumber(n)}`)
                        .join(' · ') || 'idle'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-2xs leading-4 text-subtle">
                Jobs only run while <code className="rounded bg-surface-2 px-1">npm run worker</code>{' '}
                is running.
              </p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Credential management"
          description="Use Connections to add or update workspace API keys. Environment variables are still supported as server-side fallbacks."
        />
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="max-w-xl text-[13px] leading-5 text-muted">
            Saved workspace credentials override matching environment variables and are never
            sent back to the browser. OpenStreetMap requires no key and remains available by
            default.
          </p>
          <Link href="/settings/connections">
            <Button variant="primary" size="sm">
              Manage connections
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  )
}

function StateIcon({ state }: { state: Status['state'] }) {
  if (state === 'CONNECTED') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
  if (state === 'ERROR') return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
  return <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
}

function StateBadge({ state }: { state: Status['state'] }) {
  if (state === 'CONNECTED') return <Badge tone="ok">Connected</Badge>
  if (state === 'ERROR') return <Badge tone="danger">Error</Badge>
  return <Badge tone="neutral">Not connected</Badge>
}
