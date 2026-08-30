'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlarmClock, ArrowRight, Inbox, Search, Sparkles } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Input, Spinner } from '@/components/ui/primitives'
import { PhoneValue } from '@/components/crm/copy-value'
import { cn, formatNumber } from '@/lib/utils'

/**
 * The queue an agent works.
 *
 * Ordering is decided on the server and not exposed as a sort control: the
 * point of a calling queue is that the next call is chosen for you. What the
 * agent gets instead is the reason a lead is where it is — overdue, due today,
 * never called — which is more useful than the ability to reorder.
 *
 * "Start calling" jumps to the top of the queue, because the most common action
 * on this page is not choosing a lead but beginning.
 */

interface QueueItemView {
  id: string
  name: string
  primaryPhone: string | null
  city: string | null
  region: string | null
  category: string | null
  websiteUrl: string | null
  leadScore: number | null
  callCount: number
  lastCallAt: string | null
  lastCallOutcome: string | null
  nextFollowUpAt: string | null
  bucket: 'overdue' | 'today' | 'new' | 'working' | 'upcoming'
}

interface Counts {
  overdue: number
  today: number
  new: number
  working: number
  upcoming: number
  total: number
}

const BUCKETS = [
  { id: 'all', label: 'Everything', key: 'total' },
  { id: 'overdue', label: 'Overdue', key: 'overdue' },
  { id: 'today', label: 'Due today', key: 'today' },
  { id: 'new', label: 'Never called', key: 'new' },
  { id: 'working', label: 'In progress', key: 'working' },
  { id: 'upcoming', label: 'Scheduled', key: 'upcoming' },
] as const

const BUCKET_BADGE: Record<QueueItemView['bucket'], { tone: 'danger' | 'warn' | 'accent' | 'info' | 'neutral'; label: string }> = {
  overdue: { tone: 'danger', label: 'Overdue' },
  today: { tone: 'warn', label: 'Due today' },
  new: { tone: 'accent', label: 'New' },
  working: { tone: 'info', label: 'In progress' },
  upcoming: { tone: 'neutral', label: 'Scheduled' },
}

function outcomeLabel(value: string | null): string | null {
  if (!value) return null
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function dueLabel(iso: string | null): string | null {
  if (!iso) return null
  const due = new Date(iso)
  const diffMin = Math.round((due.getTime() - Date.now()) / 60_000)
  if (diffMin < -1440) return `${Math.abs(Math.round(diffMin / 1440))}d overdue`
  if (diffMin < -60) return `${Math.abs(Math.round(diffMin / 60))}h overdue`
  if (diffMin < 0) return `${Math.abs(diffMin)}m overdue`
  if (diffMin < 60) return `in ${diffMin}m`
  if (diffMin < 1440) return `in ${Math.round(diffMin / 60)}h`
  return due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function AgentQueue({
  initialItems,
  initialTotal,
  initialCounts,
  initialBucket,
}: {
  initialItems: QueueItemView[]
  initialTotal: number
  initialCounts: Counts
  initialBucket: string
}) {
  const router = useRouter()
  const [bucket, setBucket] = useState(initialBucket)
  const [items, setItems] = useState(initialItems)
  const [total, setTotal] = useState(initialTotal)
  const [counts, setCounts] = useState(initialCounts)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (nextBucket: string, nextSearch: string) => {
      setLoading(true)
      try {
        const params = new URLSearchParams({ bucket: nextBucket, take: '50' })
        if (nextSearch.trim()) params.set('search', nextSearch.trim())
        const res = await fetch(`/api/crm/queue?${params}`, { cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json()
        setItems(json.items)
        setTotal(json.total)
        setCounts(json.counts)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  // Debounce search so a typed query is one request, not one per keystroke.
  useEffect(() => {
    if (search === '') return
    const id = setTimeout(() => void load(bucket, search), 300)
    return () => clearTimeout(id)
  }, [search, bucket, load])

  const first = items[0]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">My queue</h1>
          <p className="mt-1 text-[13px] text-muted">
            {counts.total === 0
              ? 'Nothing assigned to you right now.'
              : `${formatNumber(counts.total)} lead${counts.total === 1 ? '' : 's'} assigned to you.`}
            {counts.overdue > 0 && (
              <span className="ml-1 font-medium text-danger">
                {counts.overdue} follow-up{counts.overdue === 1 ? '' : 's'} overdue.
              </span>
            )}
          </p>
        </div>
        {first && (
          <Link href={`/agent/lead/${first.id}`}>
            <Button variant="primary">
              Start calling
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {BUCKETS.map((b) => {
          const n = counts[b.key as keyof Counts]
          const active = bucket === b.id
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                setBucket(b.id)
                void load(b.id, search)
                router.replace(`/agent?bucket=${b.id}`, { scroll: false })
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors',
                active
                  ? 'border-accent/30 bg-accent-soft font-semibold text-accent'
                  : 'border-border text-muted hover:bg-surface-2 hover:text-fg',
                b.id === 'overdue' && n > 0 && !active && 'border-danger/30 text-danger',
              )}
            >
              {b.label}
              <span className="tnum text-2xs opacity-70">{n}</span>
            </button>
          )
        })}

        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              if (e.target.value === '') void load(bucket, '')
            }}
            placeholder="Search your queue"
            className="w-[220px] pl-8"
          />
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" />
          Loading…
        </div>
      )}

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={counts.total === 0 ? <Inbox className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
            title={counts.total === 0 ? 'No leads assigned yet' : 'Nothing in this list'}
            description={
              counts.total === 0
                ? 'Your supervisor assigns leads to you. When they do, they appear here in the order they should be called.'
                : 'Try another list, or clear the search.'
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {items.map((item) => {
              const badge = BUCKET_BADGE[item.bucket]
              const due = dueLabel(item.nextFollowUpAt)
              return (
                <li key={item.id}>
                  <div className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-surface-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/agent/lead/${item.id}`}
                          className="truncate text-sm font-medium hover:text-accent hover:underline"
                        >
                          {item.name}
                        </Link>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                        {due && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 text-2xs',
                              item.bucket === 'overdue' ? 'font-medium text-danger' : 'text-subtle',
                            )}
                          >
                            <AlarmClock className="h-3 w-3" />
                            {due}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-2xs text-subtle">
                        {[item.category, item.city, item.region].filter(Boolean).join(' · ') ||
                          'No location recorded'}
                        {item.callCount > 0 && (
                          <>
                            {' · '}
                            {item.callCount} call{item.callCount === 1 ? '' : 's'}
                            {item.lastCallOutcome && ` · last: ${outcomeLabel(item.lastCallOutcome)}`}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0">
                      <PhoneValue phone={item.primaryPhone} size="sm" />
                    </div>

                    <Link href={`/agent/lead/${item.id}`} className="shrink-0">
                      <Button size="sm" variant="secondary">
                        Open
                      </Button>
                    </Link>
                  </div>
                </li>
              )
            })}
          </ul>

          {total > items.length && (
            <div className="border-t border-border px-5 py-2.5 text-center text-2xs text-subtle">
              Showing {items.length} of {formatNumber(total)}. Work through these and
              the rest will follow.
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
