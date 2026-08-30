'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { UserCheck, UserMinus } from 'lucide-react'
import { Badge, Button, Card, CardHeader, Select } from '@/components/ui/primitives'
import { Avatar } from '@/components/crm/team-manager'
import { formatDateTime } from '@/lib/utils'

/**
 * Who is calling this lead.
 *
 * Assignment is presented as a single decision rather than a workflow: pick a
 * person, or take it back. The panel also states plainly when a lead cannot be
 * assigned — a do-not-call lead is not merely unassigned, it is off limits, and
 * a disabled control with no explanation would just look broken.
 */

export interface AgentOption {
  id: string
  name: string
  role: string
  openLeads: number
}

export function AssignmentPanel({
  businessId,
  agents,
  assignedTo,
  assignedAt,
  doNotCall,
  callCount,
  nextFollowUpAt,
}: {
  businessId: string
  agents: AgentOption[]
  assignedTo: { id: string; name: string | null; email: string; avatarPath: string | null } | null
  assignedAt: string | null
  doNotCall: boolean
  callCount: number
  nextFollowUpAt: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState('')

  async function send(body: unknown) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/crm/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not update the assignment')
        return
      }
      // The service reports why rows were skipped instead of silently dropping
      // them; surfacing that is the difference between "done" and "done to 0".
      if (Array.isArray(json.reasons) && json.reasons.length > 0) {
        setError(json.reasons.join('. '))
        return
      }
      setChoice('')
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Calling"
        description={
          callCount === 0
            ? 'This lead has never been called.'
            : `${callCount} call${callCount === 1 ? '' : 's'} logged.`
        }
      />
      <div className="space-y-3 px-5 py-4 text-[13px]">
        {doNotCall ? (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-danger">
            <div className="font-semibold">Do not call</div>
            <p className="mt-0.5 text-2xs leading-4">
              This business asked not to be contacted. It cannot be assigned to
              anyone, by hand or automatically.
            </p>
          </div>
        ) : assignedTo ? (
          <>
            <div className="flex items-center gap-2.5">
              <Avatar member={{ ...assignedTo, id: assignedTo.id }} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {assignedTo.name ?? assignedTo.email}
                </div>
                {assignedAt && (
                  <div className="text-2xs text-subtle">
                    Assigned {formatDateTime(assignedAt)}
                  </div>
                )}
              </div>
            </div>

            {nextFollowUpAt && (
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <span className="text-2xs uppercase tracking-wide text-subtle">
                  Next follow-up
                </span>
                <div
                  className={
                    new Date(nextFollowUpAt) < new Date() ? 'font-medium text-danger' : ''
                  }
                >
                  {formatDateTime(nextFollowUpAt)}
                  {new Date(nextFollowUpAt) < new Date() && ' · overdue'}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Select
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className="flex-1"
                disabled={busy}
              >
                <option value="">Reassign to…</option>
                {agents
                  .filter((a) => a.id !== assignedTo.id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.openLeads})
                    </option>
                  ))}
              </Select>
              <Button
                size="sm"
                variant="primary"
                disabled={!choice || busy}
                loading={busy && Boolean(choice)}
                onClick={() =>
                  void send({ mode: 'ids', assignedToId: choice, businessIds: [businessId] })
                }
              >
                <UserCheck className="h-3.5 w-3.5" />
                Move
              </Button>
            </div>

            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-center"
              disabled={busy}
              onClick={() => void send({ mode: 'unassign', businessIds: [businessId] })}
            >
              <UserMinus className="h-3.5 w-3.5" />
              Return to the pool
            </Button>
          </>
        ) : (
          <>
            <div className="text-muted">
              Not assigned. Nobody is calling this lead.
            </div>
            {agents.length === 0 ? (
              <p className="text-2xs text-subtle">
                There are no agents in this workspace yet. Add one from the Team
                page first.
              </p>
            ) : (
              <div className="flex gap-2">
                <Select
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                  className="flex-1"
                  disabled={busy}
                >
                  <option value="">Assign to…</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.openLeads})
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!choice || busy}
                  loading={busy}
                  onClick={() =>
                    void send({ mode: 'ids', assignedToId: choice, businessIds: [businessId] })
                  }
                >
                  Assign
                </Button>
              </div>
            )}
            <p className="text-2xs text-subtle">
              The number beside each name is how many open leads they already
              hold.
            </p>
          </>
        )}

        {error && <p className="text-2xs text-danger">{error}</p>}
      </div>
    </Card>
  )
}

/** The calling record, newest first. Read-only — call logs are never edited. */
export function CallHistoryCard({
  calls,
  outcomes,
}: {
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
  outcomes: Array<{ value: string; label: string; tone: 'neutral' | 'info' | 'ok' | 'warn' | 'danger' }>
}) {
  if (calls.length === 0) return null

  const meta = new Map(outcomes.map((o) => [o.value, o]))

  return (
    <Card>
      <CardHeader
        title="Call history"
        description="Every call as it was logged. These records are never edited."
      />
      <ul className="divide-y divide-border">
        {calls.map((c) => {
          const m = meta.get(c.outcome)
          return (
            <li key={c.id} className="px-5 py-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={m?.tone ?? 'neutral'}>{m?.label ?? c.outcome}</Badge>
                <span className="text-muted">{c.by}</span>
                <span className="text-2xs text-subtle">{formatDateTime(c.createdAt)}</span>
                {c.durationSec !== null && (
                  <span className="tnum text-2xs text-subtle">
                    {Math.floor(c.durationSec / 60)}:
                    {String(c.durationSec % 60).padStart(2, '0')}
                  </span>
                )}
              </div>
              {c.notes && (
                <p className="mt-1.5 whitespace-pre-wrap leading-5 text-muted">{c.notes}</p>
              )}
              {c.followUpAt && (
                <p className="mt-1 text-2xs text-subtle">
                  Follow-up set for {formatDateTime(c.followUpAt)}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
