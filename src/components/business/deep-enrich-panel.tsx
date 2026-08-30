'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Check, AlertCircle, MinusCircle, XCircle } from 'lucide-react'
import { Badge, Button, Modal, Spinner } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'

/**
 * "Find missing details" — deep enrichment for one business.
 *
 * Surfaces every step and its outcome rather than a spinner and a number,
 * because the interesting answer is often *why* something was not found: no
 * candidate domain resolved, the site publishes no structured data, Yelp has no
 * match. That tells the user whether to try another route or give up.
 */

type StepStatus = 'ok' | 'skipped' | 'failed' | 'not-found'

interface Step {
  step: string
  status: StepStatus
  detail: string
}

interface Result {
  steps: Step[]
  websiteFound: string | null
  contactsAdded: number
  phonesAdded: number
  emailsAdded: number
  socialsAdded: number
  fieldsFilled: string[]
  auditQueued: boolean
}

export function DeepEnrichPanel({
  businessId,
  missing,
}: {
  businessId: string
  /** Short labels for what this record is currently lacking. */
  missing: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`/api/businesses/${businessId}/deep-enrich`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Enrichment failed')
        return
      }
      setResult(json as Result)
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Search className="h-3.5 w-3.5" />
        Find missing details
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Find missing details"
        description="Searches for this business without using any paid search quota."
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button variant="primary" onClick={run} loading={running}>
              {result ? 'Run again' : 'Start search'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {missing.length > 0 && (
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[13px]">
              <span className="text-muted">Currently missing: </span>
              {missing.map((m) => (
                <Badge key={m} tone="warn" className="ml-1">
                  {m}
                </Badge>
              ))}
            </div>
          )}

          <ol className="space-y-1.5 text-[13px] text-muted">
            {[
              'Derive likely domains from the business name and verify each one actually belongs to this business',
              'Crawl the confirmed website — up to 10 pages, including contact and about',
              'Read schema.org business data published by the site',
              'Match against Yelp Fusion, if a key is configured (free tier)',
            ].map((line, i) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold">
                  {i + 1}
                </span>
                {line}
              </li>
            ))}
          </ol>

          <p className="text-2xs leading-4 text-subtle">
            This can take up to a minute — it fetches several sites. Nothing here
            consumes SerpApi credits.
          </p>

          {running && (
            <div className="flex items-center gap-2.5 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2.5 text-[13px] text-accent">
              <Spinner className="h-4 w-4" />
              Searching…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-[13px]',
                  result.contactsAdded > 0 || result.websiteFound
                    ? 'border-ok/25 bg-ok/10 text-ok'
                    : 'border-border bg-surface-2 text-muted',
                )}
              >
                {result.contactsAdded > 0 || result.websiteFound ? (
                  <>
                    Added {result.contactsAdded} contact
                    {result.contactsAdded === 1 ? '' : 's'}
                    {result.phonesAdded > 0 && ` · ${result.phonesAdded} phone`}
                    {result.emailsAdded > 0 && ` · ${result.emailsAdded} email`}
                    {result.socialsAdded > 0 && ` · ${result.socialsAdded} social`}
                    {result.fieldsFilled.length > 0 && ` · filled ${result.fieldsFilled.join(', ')}`}
                    {result.auditQueued && ' · audit queued'}
                  </>
                ) : (
                  'Nothing new found. The steps below show where it looked.'
                )}
              </div>

              <ul className="divide-y divide-border rounded-lg border border-border">
                {result.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                    <StepIcon status={s.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">{s.step}</div>
                      <div className="text-2xs leading-4 text-muted">{s.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'ok') return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
  if (status === 'failed') return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
  if (status === 'not-found') return <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
  return <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
}
