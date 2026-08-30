'use client'

import { Lightbulb } from 'lucide-react'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'

/**
 * Evidence-based sales summary (§28).
 *
 * Strictly assembled from stored measurements. It deliberately makes no revenue
 * claims — "you are losing £50,000 because your site is slow" is exactly the
 * kind of unsupported assertion the brief rules out, and it is the first thing a
 * sceptical prospect will challenge.
 */

interface OpportunityInput {
  kind: string
  triggered: boolean
  score: number
  reasons: Array<{ label: string; detail?: string }>
}

const SERVICE_NAMES: Record<string, string> = {
  WEBSITE_CREATION: 'Website Creation',
  REDESIGN: 'Website Redesign',
  SEO: 'SEO',
  SPEED: 'Speed Optimization',
}

export function SalesSummary({
  businessName,
  opportunities,
  rating,
  reviewCount,
  hasPhone,
  hasEmail,
  perfMobile,
  isDemo,
}: {
  businessName: string
  opportunities: OpportunityInput[]
  rating: number | null
  reviewCount: number | null
  hasPhone: boolean
  hasEmail: boolean
  perfMobile: number | null
  isDemo: boolean
}) {
  const triggered = opportunities
    .filter((o) => o.triggered)
    .sort((a, b) => b.score - a.score)

  if (triggered.length === 0) return null

  const services = triggered.map((o) => SERVICE_NAMES[o.kind] ?? o.kind)

  // "Why" is built only from reasons the scoring engine actually recorded.
  const evidence = triggered
    .flatMap((o) => o.reasons.slice(0, 3).map((r) => r.label))
    .filter(Boolean)
    .slice(0, 6)

  const established =
    (reviewCount ?? 0) >= 25 || (rating !== null && rating >= 4.2)

  const reachable = hasPhone || hasEmail

  const angle = buildAngle({
    businessName,
    established,
    rating,
    reviewCount,
    perfMobile,
    primary: triggered[0]!.kind,
  })

  return (
    <Card>
      <CardHeader
        title="Sales summary"
        description="Assembled from the stored evidence above. No claims beyond what was measured."
        actions={<Lightbulb className="h-4 w-4 text-warn" />}
      />
      <div className="space-y-4 px-5 py-4">
        {isDemo && (
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
            This is a demo record. The summary below describes synthetic data and is not a
            real sales opportunity.
          </div>
        )}

        <div>
          <div className="text-2xs font-semibold uppercase tracking-wide text-subtle">
            Recommended service
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {services.map((s) => (
              <Badge key={s} tone="accent">
                {s}
              </Badge>
            ))}
          </div>
        </div>

        <div>
          <div className="text-2xs font-semibold uppercase tracking-wide text-subtle">Why</div>
          <ul className="mt-1 space-y-1">
            {evidence.map((e, i) => (
              <li key={i} className="flex gap-2 text-[13px] leading-5">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-subtle" />
                {e}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="text-2xs font-semibold uppercase tracking-wide text-subtle">
            Pitch angle
          </div>
          <p className="mt-1 text-[13px] leading-5 text-muted">{angle}</p>
        </div>

        <p className="border-t border-border pt-3 text-2xs leading-4 text-subtle">
          {reachable
            ? 'A direct contact route exists for this business.'
            : 'No phone or email was found — outreach would need another route, which lowers this lead’s priority.'}
        </p>
      </div>
    </Card>
  )
}

function buildAngle(input: {
  businessName: string
  established: boolean
  rating: number | null
  reviewCount: number | null
  perfMobile: number | null
  primary: string
}): string {
  const { businessName, established, rating, reviewCount, perfMobile, primary } = input

  const reputation =
    established && rating !== null && reviewCount !== null
      ? `${businessName} has a strong local reputation (${rating.toFixed(1)}★ from ${reviewCount} reviews)`
      : `${businessName} is trading locally`

  switch (primary) {
    case 'WEBSITE_CREATION':
      return `${reputation}, but no website was found on any source we searched. Enquiries that start with a search have nowhere to land.`
    case 'SPEED':
      return perfMobile !== null
        ? `${reputation}, but the site scores ${perfMobile}/100 for mobile performance. Slow mobile loading is measurable and fixable, and it is what most local visitors experience first.`
        : `${reputation}, and the site's measured performance is below the good threshold.`
    case 'REDESIGN':
      return `${reputation}, but the site has measurable layout and usability defects at mobile widths — the specific elements and viewports are listed in the evidence above.`
    case 'SEO':
      return `${reputation}, but the site is missing basic on-page SEO fundamentals. These are concrete, verifiable gaps rather than a vague ranking promise.`
    default:
      return `${reputation}. The audit above lists the specific, reproducible issues found on the site.`
  }
}
