import 'server-only'
import { prisma } from '@/server/db/client'
import type { IssueDraft } from '../types'
import { CWV, rateMetric, type PerfMeasurement, type PerformanceProvider, type PerfStrategyName } from './types'
import { PageSpeedProvider } from './pagespeed'
import { LighthouseProvider } from './lighthouse'

/**
 * Performance stage (§4 Tab 4, §6).
 *
 * Mobile and desktop are measured and stored separately — a site can be fine on
 * a laptop and unusable on a phone, and that difference is the sales argument.
 */

const PROVIDERS: PerformanceProvider[] = [
  new PageSpeedProvider(),
  new LighthouseProvider(),
]

export function performanceProviders(): PerformanceProvider[] {
  return PROVIDERS
}

export function getPerformanceProvider(id: string): PerformanceProvider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** Chooses the best available provider: real data whenever real data is possible. */
export async function selectPerformanceProvider(
  _preferDemo: boolean,
  workspaceId?: string,
): Promise<PerformanceProvider> {
  for (const p of PROVIDERS) {
    const status = await p.configured(workspaceId)
    if (status.state === 'CONNECTED') return p
  }
  throw new Error('No performance provider is available. Add PageSpeed credentials or configure local Lighthouse.')
}

export interface PerformanceOutput {
  measurements: Array<{ strategy: PerfStrategyName; measurement: PerfMeasurement }>
  issues: IssueDraft[]
}

/**
 * §33 — never re-run an expensive measurement when a recent one exists, unless
 * the user explicitly asked for a fresh run.
 */
export async function findCachedMeasurement(
  businessId: string,
  strategy: PerfStrategyName,
  maxAgeHours: number,
) {
  const since = new Date(Date.now() - maxAgeHours * 3_600_000)
  return prisma.performanceResult.findFirst({
    where: {
      strategy,
      measuredAt: { gte: since },
      audit: { businessId, status: { in: ['COMPLETED', 'PARTIAL'] } },
    },
    orderBy: { measuredAt: 'desc' },
  })
}

export async function runPerformanceAudit(
  url: string,
  provider: PerformanceProvider,
  strategies: PerfStrategyName[] = ['MOBILE', 'DESKTOP'],
  workspaceId?: string,
): Promise<PerformanceOutput> {
  const measurements: PerformanceOutput['measurements'] = []
  const issues: IssueDraft[] = []
  const errors: string[] = []

  for (const strategy of strategies) {
    try {
      const measurement = await provider.run(url, strategy, { workspaceId })
      measurements.push({ strategy, measurement })
      issues.push(...measurementIssues(measurement, strategy, url))
    } catch (err) {
      // Desktop failing must not discard a successful mobile run (§31).
      errors.push(`${strategy}: ${(err as Error).message}`)
    }
  }

  if (measurements.length === 0) {
    throw new Error(errors.join('; ') || 'No performance measurement could be taken')
  }

  return { measurements, issues }
}

function measurementIssues(
  m: PerfMeasurement,
  strategy: PerfStrategyName,
  url: string,
): IssueDraft[] {
  const issues: IssueDraft[] = []
  const label = strategy === 'MOBILE' ? 'Mobile' : 'Desktop'
  const source = m.isDemo ? 'PROVIDER' : 'PROVIDER'

  if (m.score !== null && m.score < 50) {
    issues.push({
      type: `performance.score.poor.${strategy.toLowerCase()}`,
      category: 'PERFORMANCE',
      severity: strategy === 'MOBILE' ? 'HIGH' : 'MEDIUM',
      confidence: 'HIGH',
      title: `${label} performance score is ${m.score}/100`,
      description: `A lab performance score below 50 puts this page in the slowest band. Measured by ${m.provider}${m.isDemo ? ' (DEMO DATA)' : ''}.`,
      evidence: {
        strategy,
        score: m.score,
        provider: m.provider,
        isDemo: m.isDemo,
        lcpMs: m.lcpMs,
        clsScore: m.cls,
        tbtMs: m.tbtMs,
      },
      affectedUrl: url,
      source,
      recommendedAction:
        'Address the highest-saving opportunities first — typically image weight, render-blocking resources and unused JavaScript.',
    })
  } else if (m.score !== null && m.score < 75) {
    issues.push({
      type: `performance.score.moderate.${strategy.toLowerCase()}`,
      category: 'PERFORMANCE',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `${label} performance score is ${m.score}/100`,
      description: 'The page is usable but leaves measurable speed on the table.',
      evidence: { strategy, score: m.score, provider: m.provider, isDemo: m.isDemo },
      affectedUrl: url,
      source,
      recommendedAction: 'Work through the reported opportunities to reach the green band (90+).',
    })
  }

  // ── Core Web Vitals, lab values ────────────────────────────────────────────
  if (rateMetric(m.lcpMs, CWV.lcp) === 'poor') {
    issues.push({
      type: `performance.lcp.poor.${strategy.toLowerCase()}`,
      category: 'PERFORMANCE',
      severity: strategy === 'MOBILE' ? 'HIGH' : 'MEDIUM',
      confidence: 'HIGH',
      title: `${label} Largest Contentful Paint is ${(m.lcpMs! / 1000).toFixed(1)}s`,
      description: `The main content takes ${(m.lcpMs! / 1000).toFixed(1)}s to appear. Google's "good" threshold is 2.5s and "poor" begins at 4.0s.`,
      evidence: {
        metric: 'LCP',
        strategy,
        valueMs: m.lcpMs,
        goodThresholdMs: CWV.lcp.good,
        poorThresholdMs: CWV.lcp.poor,
        provider: m.provider,
        isDemo: m.isDemo,
      },
      affectedUrl: url,
      source,
      recommendedAction:
        'Optimise the hero image (correct dimensions, modern format, preload), reduce server response time and remove render-blocking CSS.',
    })
  }

  if (rateMetric(m.cls, CWV.cls) === 'poor') {
    issues.push({
      type: `performance.cls.poor.${strategy.toLowerCase()}`,
      category: 'PERFORMANCE',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `${label} Cumulative Layout Shift is ${m.cls}`,
      description:
        'Page content moves while loading, which causes mis-taps. "Good" is 0.1 or below; "poor" begins at 0.25.',
      evidence: {
        metric: 'CLS',
        strategy,
        value: m.cls,
        goodThreshold: CWV.cls.good,
        poorThreshold: CWV.cls.poor,
        provider: m.provider,
        isDemo: m.isDemo,
      },
      affectedUrl: url,
      source,
      recommendedAction:
        'Set explicit width/height on images and embeds, and reserve space for banners and late-loading fonts.',
    })
  }

  // ── Field data, when real users have supplied it ───────────────────────────
  if (m.fieldInpMs !== null && rateMetric(m.fieldInpMs, CWV.inp) === 'poor') {
    issues.push({
      type: `performance.inp.poor.${strategy.toLowerCase()}`,
      category: 'PERFORMANCE',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `Real users experience ${m.fieldInpMs}ms interaction delay`,
      description: `Interaction to Next Paint from ${m.fieldSource}. Above 500ms is classed as poor — taps feel unresponsive.`,
      evidence: {
        metric: 'INP',
        strategy,
        valueMs: m.fieldInpMs,
        fieldSource: m.fieldSource,
        thresholds: CWV.inp,
      },
      affectedUrl: url,
      source,
      recommendedAction: 'Break up long JavaScript tasks and defer non-critical work on interaction.',
    })
  }

  if (rateMetric(m.ttfbMs, CWV.ttfb) === 'poor') {
    issues.push({
      type: `performance.ttfb.slow.${strategy.toLowerCase()}`,
      category: 'PERFORMANCE',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `Server takes ${m.ttfbMs}ms to respond (${label.toLowerCase()})`,
      description:
        'Time to first byte is slow, which delays everything that follows regardless of front-end optimisation.',
      evidence: { metric: 'TTFB', strategy, valueMs: m.ttfbMs, thresholds: CWV.ttfb },
      affectedUrl: url,
      source,
      recommendedAction: 'Add server-side caching or a CDN, and review hosting quality.',
    })
  }

  // ── Weight ─────────────────────────────────────────────────────────────────
  const WEIGHT_LIMIT = 3_000_000
  if (m.pageWeightBytes !== null && m.pageWeightBytes > WEIGHT_LIMIT) {
    issues.push({
      type: `performance.page_weight.heavy.${strategy.toLowerCase()}`,
      category: 'PERFORMANCE',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `Page transfers ${(m.pageWeightBytes / 1_048_576).toFixed(1)} MB`,
      description:
        'A heavy page is slow and expensive on mobile data, and is usually dominated by unoptimised images.',
      evidence: {
        strategy,
        totalBytes: m.pageWeightBytes,
        imageBytes: m.imageBytes,
        scriptBytes: m.scriptBytes,
        requestCount: m.requestCount,
        limitBytes: WEIGHT_LIMIT,
      },
      affectedUrl: url,
      source,
      recommendedAction:
        'Compress and resize images, serve WebP/AVIF, and remove unused scripts.',
    })
  }

  if (m.renderBlockingCount !== null && m.renderBlockingCount >= 3) {
    issues.push({
      type: `performance.render_blocking.${strategy.toLowerCase()}`,
      category: 'PERFORMANCE',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `${m.renderBlockingCount} render-blocking resources`,
      description: 'Stylesheets and scripts in the document head delay first paint.',
      evidence: {
        strategy,
        count: m.renderBlockingCount,
        opportunities: m.opportunities.filter((o) => o.id === 'render-blocking-resources'),
      },
      affectedUrl: url,
      source,
      recommendedAction: 'Inline critical CSS and defer the rest; add defer/async to scripts.',
    })
  }

  return issues
}

export { CWV, rateMetric }
export type { PerfMeasurement, PerformanceProvider, PerfStrategyName }
