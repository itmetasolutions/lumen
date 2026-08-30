'use client'

import { useState } from 'react'
import { ChevronDown, ExternalLink, Sparkles, FlaskConical } from 'lucide-react'
import { Badge, SeverityBadge } from '@/components/ui/primitives'
import { cn, formatDateTime } from '@/lib/utils'

/**
 * Issue list with expandable evidence (§11).
 *
 * The evidence blob is rendered verbatim. That is deliberate: a salesperson
 * needs to be able to say "here is the selector we checked and the value we
 * measured", and a developer on the other side of the call needs to be able to
 * reproduce it.
 */

export interface SerializedIssue {
  id: string
  type: string
  category: string
  severity: string
  confidence: string
  title: string
  description: string
  evidence: unknown
  affectedUrl: string | null
  source: string
  recommendedAction: string
  detectedAt: string
}

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']

export function IssueList({
  issues,
  emptyMessage,
}: {
  issues: SerializedIssue[]
  emptyMessage: string
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())

  if (issues.length === 0) {
    return <div className="px-5 py-4 text-[13px] text-muted">{emptyMessage}</div>
  }

  const sorted = [...issues].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  )

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <ul className="divide-y divide-border">
      {sorted.map((issue) => {
        const expanded = open.has(issue.id)
        const isAi = issue.source === 'AI_ASSISTED'

        return (
          <li key={issue.id}>
            <button
              onClick={() => toggle(issue.id)}
              className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-surface-2"
              aria-expanded={expanded}
            >
              <ChevronDown
                className={cn(
                  'mt-1 h-3.5 w-3.5 shrink-0 text-subtle transition-transform',
                  expanded && 'rotate-180',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium">{issue.title}</span>
                  <SeverityBadge severity={issue.severity} />
                  {issue.confidence !== 'HIGH' && (
                    <Badge tone="outline">confidence: {issue.confidence.toLowerCase()}</Badge>
                  )}
                  {isAi ? (
                    <Badge tone="accent">
                      <Sparkles className="h-2.5 w-2.5" />
                      AI-assisted
                    </Badge>
                  ) : issue.source === 'PROVIDER' ? (
                    <Badge tone="outline">provider measurement</Badge>
                  ) : (
                    <Badge tone="outline">
                      <FlaskConical className="h-2.5 w-2.5" />
                      measured
                    </Badge>
                  )}
                </div>
                {!expanded && (
                  <p className="mt-0.5 line-clamp-1 text-[13px] text-muted">
                    {issue.description}
                  </p>
                )}
              </div>
            </button>

            {expanded && (
              <div className="space-y-3 border-t border-border bg-surface-2/50 px-5 py-3.5 pl-[46px]">
                <p className="text-[13px] leading-5">{issue.description}</p>

                <div>
                  <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">
                    Evidence
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-surface p-3 text-2xs leading-4 text-muted">
                    {JSON.stringify(issue.evidence, null, 2)}
                  </pre>
                </div>

                <div>
                  <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">
                    Recommended fix
                  </div>
                  <p className="text-[13px] leading-5">{issue.recommendedAction}</p>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-2xs text-subtle">
                  <span>Rule: <code className="rounded bg-surface px-1">{issue.type}</code></span>
                  <span>Detected {formatDateTime(issue.detectedAt)}</span>
                  {issue.affectedUrl && (
                    <a
                      href={issue.affectedUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      Affected URL
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
