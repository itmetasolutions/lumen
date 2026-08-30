import type { Confidence, Severity } from '@prisma/client'
import type { IssueDraft } from '@/server/audit/types'
import type { ScoringWeights } from './weights'

/**
 * The scoring engine (§14, §15).
 *
 * The distinction this file exists to preserve: **health and opportunity are
 * inverse concepts, not the same number**. SEO Health 28 means the site's SEO is
 * bad. SEO Opportunity 86 means there is a lot for us to sell. They are computed
 * separately, stored separately, and displayed separately.
 */

export interface ScoreReason {
  label: string
  detail: string
  /** Signed contribution, for showing "why" in the UI. */
  weight: number
  evidenceTypes?: string[]
}

export interface ScoredValue {
  score: number
  reasons: ScoreReason[]
}

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n))

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Health = 100 minus accumulated, confidence-weighted penalties.
 * A site with no detected issues scores 100; that is a real statement, not a
 * default, because it only happens after the checks actually ran.
 */
export function healthFromIssues(
  issues: IssueDraft[],
  weights: ScoringWeights,
): ScoredValue {
  let penalty = 0
  const bySeverity = new Map<Severity, number>()

  for (const issue of issues) {
    const sev = weights.severity[issue.severity as keyof typeof weights.severity] ?? 0
    const conf =
      weights.confidence[issue.confidence as keyof typeof weights.confidence] ?? 1
    penalty += sev * conf
    bySeverity.set(issue.severity, (bySeverity.get(issue.severity) ?? 0) + 1)
  }

  const score = clamp(Math.round(100 - penalty))
  const reasons: ScoreReason[] = []

  for (const [severity, count] of Array.from(bySeverity.entries()).sort(
    (a, b) => severityRank(b[0]) - severityRank(a[0]),
  )) {
    reasons.push({
      label: `${count} ${severity.toLowerCase()} issue${count === 1 ? '' : 's'}`,
      detail: issues
        .filter((i) => i.severity === severity)
        .slice(0, 4)
        .map((i) => i.title)
        .join('; '),
      weight: -(weights.severity[severity as keyof typeof weights.severity] * count),
      evidenceTypes: issues.filter((i) => i.severity === severity).map((i) => i.type),
    })
  }

  if (issues.length === 0) {
    reasons.push({
      label: 'No issues detected',
      detail: 'Every check in this category passed.',
      weight: 0,
    })
  }

  return { score, reasons }
}

function severityRank(s: Severity): number {
  return { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 }[s] ?? 0
}

export function websiteHealth(
  parts: {
    seo: number | null
    performance: number | null
    ux: number | null
    technical: number | null
  },
  weights: ScoringWeights,
): number | null {
  const w = weights.websiteHealth
  const entries: Array<[number | null, number]> = [
    [parts.seo, w.seo],
    [parts.performance, w.performance],
    [parts.ux, w.ux],
    [parts.technical, w.technical],
  ]
  // Re-weight over whichever domains actually produced a score — a skipped UX
  // stage must not silently drag the composite toward zero.
  const present = entries.filter(([v]) => v !== null)
  if (present.length === 0) return null
  const totalWeight = present.reduce((sum, [, weight]) => sum + weight, 0)
  if (totalWeight === 0) return null
  const value = present.reduce((sum, [v, weight]) => sum + v! * weight, 0) / totalWeight
  return clamp(Math.round(value))
}

// ─────────────────────────────────────────────────────────────────────────────
// Business data confidence
// ─────────────────────────────────────────────────────────────────────────────

export function dataConfidence(
  b: {
    sourceCount: number
    hasPhone: boolean
    hasEmail: boolean
    hasAddress: boolean
    hasCoordinates: boolean
    hasWebsite: boolean
    reviewCount: number | null
    websiteVerified: boolean
    isDemo: boolean
  },
  weights: ScoringWeights,
): ScoredValue {
  const w = weights.dataConfidence
  const reasons: ScoreReason[] = []
  let score = 0

  // Corroboration across independent sources is the strongest signal.
  const sourcePoints = Math.min(3, b.sourceCount) * w.perSource
  score += sourcePoints
  reasons.push({
    label: `${b.sourceCount} independent source${b.sourceCount === 1 ? '' : 's'}`,
    detail:
      b.sourceCount > 1
        ? 'Multiple providers independently list this business.'
        : 'Only one provider lists this business.',
    weight: sourcePoints,
  })

  const add = (cond: boolean, points: number, label: string, detail: string) => {
    if (!cond) return
    score += points
    reasons.push({ label, detail, weight: points })
  }

  add(b.hasPhone, w.hasPhone, 'Phone number available', 'A contactable phone number was collected.')
  add(b.hasEmail, w.hasEmail, 'Email available', 'A public email address was collected.')
  add(b.hasAddress, w.hasAddress, 'Street address available', 'A postal address was collected.')
  add(b.hasCoordinates, w.hasCoordinates, 'Geocoded', 'Latitude and longitude are known.')
  add(b.hasWebsite, w.hasWebsite, 'Website recorded', 'A website URL was collected.')
  add(
    b.websiteVerified,
    w.websiteVerified,
    'Website verified reachable',
    'The crawler successfully loaded the site.',
  )
  add(
    (b.reviewCount ?? 0) >= 5,
    w.hasReviews,
    `${b.reviewCount} public reviews`,
    'Review volume corroborates that the business is trading.',
  )

  if (b.isDemo) {
    score -= w.demoPenalty
    reasons.push({
      label: 'DEMO DATA',
      detail: 'Every source for this record is a mock provider. It does not describe a real business.',
      weight: -w.demoPenalty,
    })
  }

  return { score: clamp(Math.round(score)), reasons }
}

// ─────────────────────────────────────────────────────────────────────────────
// Opportunities — independent, overlapping (§5)
// ─────────────────────────────────────────────────────────────────────────────

interface OpportunityContext {
  weights: ScoringWeights
  /** 0-100 proxy for how attractive the business is as a customer. */
  businessValue: number
}

/**
 * Shared shape: opportunity rises with the health gap, with how much concrete
 * evidence supports it, and with business value — and falls when the evidence is
 * thin. `uncertainty` is 0..1.
 */
function combineOpportunity(
  healthGap: number,
  evidenceStrength: number,
  uncertainty: number,
  ctx: OpportunityContext,
): number {
  const w = ctx.weights.opportunity
  const raw =
    w.healthGap * healthGap +
    w.evidenceStrength * evidenceStrength +
    w.businessValue * ctx.businessValue -
    w.uncertaintyPenalty * uncertainty * 100
  const total = w.healthGap + w.evidenceStrength + w.businessValue
  return clamp(Math.round(raw / (total || 1)))
}

/** Evidence strength: severity-weighted issue volume, saturating at ~8 findings. */
export function evidenceStrength(issues: IssueDraft[], weights: ScoringWeights): number {
  if (issues.length === 0) return 0
  const points = issues.reduce((sum, i) => {
    const sev = weights.severity[i.severity as keyof typeof weights.severity] ?? 0
    const conf = weights.confidence[i.confidence as keyof typeof weights.confidence] ?? 1
    return sum + sev * conf
  }, 0)
  return clamp(Math.round((points / 80) * 100))
}

export function websiteCreationOpportunity(
  b: {
    websiteStatus: string
    hasSocial: boolean
    hasPhone: boolean
    reviewCount: number | null
    rating: number | null
    isDemo: boolean
  },
  ctx: OpportunityContext,
): ScoredValue & { triggered: boolean } {
  const reasons: ScoreReason[] = []
  const noWebsite = b.websiteStatus === 'NONE' || b.websiteStatus === 'SOCIAL_ONLY'

  if (!noWebsite) {
    return {
      score: 0,
      triggered: false,
      reasons: [
        {
          label: 'Website already exists',
          detail: 'A working website was found, so this is not a website-creation lead.',
          weight: 0,
        },
      ],
    }
  }

  reasons.push({
    label:
      b.websiteStatus === 'SOCIAL_ONLY'
        ? 'Social profile only — no website'
        : 'No website found on any source',
    detail:
      b.websiteStatus === 'SOCIAL_ONLY'
        ? 'The only web presence discovered was a social media page.'
        : 'No provider returned a website URL for this business.',
    weight: 60,
  })

  // A business that clearly trades but has no site is the strongest version of
  // this lead; an unverifiable listing is the weakest.
  let evidence = 55
  if ((b.reviewCount ?? 0) >= 20) {
    evidence += 20
    reasons.push({
      label: `${b.reviewCount} reviews without a website`,
      detail: 'Established demand with no site to convert it.',
      weight: 20,
    })
  }
  if (b.hasPhone) {
    evidence += 10
    reasons.push({
      label: 'Reachable by phone',
      detail: 'A direct contact route exists for outreach.',
      weight: 10,
    })
  }
  if (b.hasSocial) {
    evidence += 8
    reasons.push({
      label: 'Active on social media',
      detail: 'Already invests in an online presence — a site is the natural next step.',
      weight: 8,
    })
  }

  // Absence of evidence is genuinely uncertain: providers do miss websites.
  const uncertainty = b.reviewCount === null && !b.hasPhone ? 0.35 : 0.12
  if (uncertainty > 0.2) {
    reasons.push({
      label: 'Limited corroborating data',
      detail:
        'Few signals confirm this business is trading, so the absence of a website is less certain.',
      weight: -15,
    })
  }

  const score = combineOpportunity(100, clamp(evidence), uncertainty, ctx)
  return {
    score,
    triggered: score >= ctx.weights.opportunity.triggerThreshold,
    reasons,
  }
}

export function redesignOpportunity(
  input: {
    uxHealth: number | null
    technicalHealth: number | null
    issues: IssueDraft[]
  },
  ctx: OpportunityContext,
): ScoredValue & { triggered: boolean } {
  const relevant = input.issues.filter(
    (i) =>
      i.category === 'UX' ||
      i.category === 'ACCESSIBILITY' ||
      (i.category === 'TECHNICAL' &&
        /obsolete|table_layout|assets\.missing|mixed_content/.test(i.type)),
  )

  // Only deterministic findings drive the score; AI commentary never does (§44).
  const deterministic = relevant.filter((i) => i.source !== 'AI_ASSISTED')

  if (input.uxHealth === null && deterministic.length === 0) {
    return {
      score: 0,
      triggered: false,
      reasons: [
        {
          label: 'Not assessed',
          detail: 'The UX stage did not run, so no redesign judgement can be made.',
          weight: 0,
        },
      ],
    }
  }

  const health = input.uxHealth ?? 100
  const gap = 100 - health
  const strength = evidenceStrength(deterministic, ctx.weights)
  const uncertainty = deterministic.length === 0 ? 0.5 : deterministic.length < 2 ? 0.2 : 0.05

  const reasons: ScoreReason[] = deterministic
    .slice(0, 8)
    .map((i) => ({
      label: i.title,
      detail: summariseEvidence(i),
      weight: ctx.weights.severity[i.severity as keyof typeof ctx.weights.severity],
      evidenceTypes: [i.type],
    }))

  if (input.technicalHealth !== null && input.technicalHealth < 60) {
    reasons.push({
      label: `Technical health ${input.technicalHealth}/100`,
      detail: 'Underlying technical problems compound the visible design issues.',
      weight: 10,
    })
  }

  const score = combineOpportunity(gap, strength, uncertainty, ctx)
  return {
    score,
    triggered: score >= ctx.weights.opportunity.triggerThreshold && deterministic.length > 0,
    reasons,
  }
}

export function seoOpportunity(
  input: { seoHealth: number | null; issues: IssueDraft[] },
  ctx: OpportunityContext,
): ScoredValue & { triggered: boolean } {
  const relevant = input.issues.filter(
    (i) => i.category === 'SEO' || i.category === 'CONTENT',
  )

  if (input.seoHealth === null) {
    return {
      score: 0,
      triggered: false,
      reasons: [
        { label: 'Not assessed', detail: 'The SEO stage did not run.', weight: 0 },
      ],
    }
  }

  const gap = 100 - input.seoHealth
  const strength = evidenceStrength(relevant, ctx.weights)
  const uncertainty = relevant.length === 0 ? 0.4 : 0.05

  const reasons: ScoreReason[] = relevant.slice(0, 10).map((i) => ({
    label: i.title,
    detail: summariseEvidence(i),
    weight: ctx.weights.severity[i.severity as keyof typeof ctx.weights.severity],
    evidenceTypes: [i.type],
  }))

  const score = combineOpportunity(gap, strength, uncertainty, ctx)
  return {
    score,
    triggered: score >= ctx.weights.opportunity.triggerThreshold && relevant.length > 0,
    reasons,
  }
}

export function speedOpportunity(
  input: {
    mobileScore: number | null
    desktopScore: number | null
    lcpMobileMs: number | null
    clsMobile: number | null
    issues: IssueDraft[]
  },
  ctx: OpportunityContext,
): ScoredValue & { triggered: boolean } {
  const relevant = input.issues.filter((i) => i.category === 'PERFORMANCE')

  if (input.mobileScore === null && input.desktopScore === null) {
    return {
      score: 0,
      triggered: false,
      reasons: [
        {
          label: 'Not measured',
          detail: 'No performance measurement was completed for this site.',
          weight: 0,
        },
      ],
    }
  }

  const w = ctx.weights.speed
  // Mobile is weighted higher because that is where local search traffic is.
  const composite =
    input.mobileScore !== null && input.desktopScore !== null
      ? input.mobileScore * w.mobileWeight + input.desktopScore * (1 - w.mobileWeight)
      : (input.mobileScore ?? input.desktopScore)!

  const gap = 100 - composite
  const strength = evidenceStrength(relevant, ctx.weights)

  const reasons: ScoreReason[] = []
  if (input.mobileScore !== null) {
    reasons.push({
      label: `Mobile performance ${input.mobileScore}/100`,
      detail:
        input.mobileScore < w.poorScore
          ? 'In the slowest band on mobile.'
          : input.mobileScore < w.weakScore
            ? 'Below the good threshold on mobile.'
            : 'Mobile performance is acceptable.',
      weight: -(100 - input.mobileScore) * w.mobileWeight,
    })
  }
  if (input.desktopScore !== null) {
    reasons.push({
      label: `Desktop performance ${input.desktopScore}/100`,
      detail:
        input.desktopScore < w.poorScore
          ? 'In the slowest band on desktop.'
          : 'Desktop performance is acceptable.',
      weight: -(100 - input.desktopScore) * (1 - w.mobileWeight),
    })
  }
  if (input.lcpMobileMs !== null) {
    reasons.push({
      label: `Mobile LCP ${(input.lcpMobileMs / 1000).toFixed(1)}s`,
      detail: 'Time until the main content appears on a phone.',
      weight: input.lcpMobileMs > 4000 ? 15 : 0,
    })
  }
  if (input.clsMobile !== null && input.clsMobile > 0.25) {
    reasons.push({
      label: `Mobile CLS ${input.clsMobile}`,
      detail: 'Layout shifts while loading, causing mis-taps.',
      weight: 10,
    })
  }

  const score = combineOpportunity(gap, strength, 0.05, ctx)
  return {
    score,
    triggered: score >= ctx.weights.opportunity.triggerThreshold && composite < w.weakScore,
    reasons,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead priority (§15)
// ─────────────────────────────────────────────────────────────────────────────

export interface LeadInput {
  opportunities: { websiteCreation: number; redesign: number; seo: number; speed: number }
  hasPhone: boolean
  hasEmail: boolean
  hasSocial: boolean
  rating: number | null
  reviewCount: number | null
  dataConfidence: number
  openingStatus: string | null
  issueCount: number
  isDemo: boolean
  weights: ScoringWeights
}

export function leadPriority(input: LeadInput): ScoredValue & { tier: 'HOT' | 'WARM' | 'LOW' } {
  const w = input.weights.leadPriority
  const reasons: ScoreReason[] = []

  // ── Need: the strongest single opportunity, plus a bonus for stacking.
  const opps = Object.values(input.opportunities)
  const maxOpp = Math.max(...opps)
  const triggeredCount = opps.filter((o) => o >= input.weights.opportunity.triggerThreshold).length
  const need = clamp(maxOpp + (triggeredCount > 1 ? (triggeredCount - 1) * 6 : 0))

  if (maxOpp > 0) {
    reasons.push({
      label: `${triggeredCount > 1 ? `${triggeredCount} overlapping opportunities` : 'Clear service need'}`,
      detail: `Highest opportunity score ${maxOpp}/100.`,
      weight: need * w.need,
    })
  }

  // ── Contactability: a lead you cannot reach is not a lead.
  let contact = 0
  if (input.hasPhone) contact += 55
  if (input.hasEmail) contact += 35
  if (input.hasSocial) contact += 10
  contact = clamp(contact)

  reasons.push({
    label: contactMessage(input),
    detail:
      contact >= 55
        ? 'A direct outreach route exists.'
        : 'No direct contact method was found, which materially lowers priority.',
    weight: contact * w.contactability,
  })

  // ── Credibility: is this a real, trading business worth approaching?
  let credibility = input.dataConfidence * 0.5
  if ((input.reviewCount ?? 0) >= 200) {
    credibility += 35
    reasons.push({
      label: `${input.reviewCount} reviews`,
      detail: 'Well-established with substantial public feedback.',
      weight: 35 * w.credibility,
    })
  } else if ((input.reviewCount ?? 0) >= 25) {
    credibility += 22
    reasons.push({
      label: `${input.reviewCount} reviews`,
      detail: 'Established business with a public track record.',
      weight: 22 * w.credibility,
    })
  }
  if (input.rating !== null && input.rating >= 4.0) {
    credibility += 12
    reasons.push({
      label: `${input.rating}★ rating`,
      detail: 'Well regarded — a business likely to invest in its presentation.',
      weight: 12 * w.credibility,
    })
  }
  if (input.openingStatus === 'CLOSED_PERMANENTLY') {
    credibility = 0
    reasons.push({
      label: 'Reported permanently closed',
      detail: 'Marked closed by a source. Not a viable lead.',
      weight: -100,
    })
  }
  credibility = clamp(credibility)

  // ── Evidence: how defensible the pitch will be in the meeting.
  const evidence = clamp(input.issueCount * 9)
  if (input.issueCount > 0) {
    reasons.push({
      label: `${input.issueCount} documented findings`,
      detail: 'Each with reproducible evidence to support the conversation.',
      weight: evidence * w.evidence,
    })
  }

  let score =
    need * w.need +
    contact * w.contactability +
    credibility * w.credibility +
    evidence * w.evidence

  const totalWeight = w.need + w.contactability + w.credibility + w.evidence
  score = clamp(Math.round(score / (totalWeight || 1)))

  if (input.isDemo) {
    score = Math.round(score * 0.4)
    reasons.unshift({
      label: 'DEMO DATA',
      detail: 'Synthetic record — priority is suppressed so demo rows never top the list.',
      weight: -40,
    })
  }
  if (input.openingStatus === 'CLOSED_PERMANENTLY') score = Math.min(score, 10)

  const tier: 'HOT' | 'WARM' | 'LOW' =
    score >= w.hotThreshold ? 'HOT' : score >= w.warmThreshold ? 'WARM' : 'LOW'

  return { score, reasons, tier }
}

function contactMessage(input: LeadInput): string {
  const parts: string[] = []
  if (input.hasPhone) parts.push('phone')
  if (input.hasEmail) parts.push('email')
  if (input.hasSocial) parts.push('social')
  return parts.length > 0 ? `Contactable by ${parts.join(' and ')}` : 'No contact method found'
}

/** Business value proxy used as an opportunity input. */
export function businessValue(b: {
  reviewCount: number | null
  rating: number | null
  hasPhone: boolean
  dataConfidence: number
}): number {
  let v = b.dataConfidence * 0.4
  if ((b.reviewCount ?? 0) >= 200) v += 40
  else if ((b.reviewCount ?? 0) >= 50) v += 28
  else if ((b.reviewCount ?? 0) >= 10) v += 15
  if (b.rating !== null && b.rating >= 4.2) v += 12
  if (b.hasPhone) v += 8
  return clamp(Math.round(v))
}

function summariseEvidence(issue: IssueDraft): string {
  const e = issue.evidence
  const bits: string[] = []
  for (const key of ['count', 'overflowPx', 'value', 'valueMs', 'score', 'missing', 'length']) {
    if (e[key] !== undefined && e[key] !== null) bits.push(`${key}: ${String(e[key])}`)
  }
  return bits.length > 0 ? bits.join(', ') : issue.description.slice(0, 140)
}

export type { Confidence, Severity }
