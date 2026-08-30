import 'server-only'
import { httpJson, HttpError, RateLimiter } from '@/server/http/client'
import { getConnectionSecret } from '@/server/settings/connections'
import type { PerfMeasurement, PerformanceProvider, PerfStrategyName } from './types'

/**
 * Google PageSpeed Insights.
 *
 * PSI returns two different things and this adapter keeps them separate:
 *  - `lighthouseResult` — a lab run on Google's hardware
 *  - `loadingExperience` — CrUX field data from real Chrome users, present only
 *    for origins with enough traffic. Absent field data is reported as null,
 *    never substituted with the lab number.
 */

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'

// PSI is heavily rate-limited without a key and still limited with one.
const limiter = new RateLimiter(0.5, 2)

interface PsiAudit {
  id?: string
  title?: string
  description?: string
  score?: number | null
  numericValue?: number
  details?: {
    overallSavingsMs?: number
    overallSavingsBytes?: number
    items?: Array<Record<string, unknown>>
  }
}

interface PsiResponse {
  error?: { message?: string; code?: number }
  loadingExperience?: {
    metrics?: Record<string, { percentile?: number; category?: string }>
    origin_fallback?: boolean
  }
  originLoadingExperience?: {
    metrics?: Record<string, { percentile?: number; category?: string }>
  }
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } }
    audits?: Record<string, PsiAudit>
  }
}

const OPPORTUNITY_IDS = [
  'render-blocking-resources',
  'unused-javascript',
  'unused-css-rules',
  'unminified-javascript',
  'unminified-css',
  'modern-image-formats',
  'uses-optimized-images',
  'uses-responsive-images',
  'offscreen-images',
  'uses-text-compression',
  'uses-long-cache-ttl',
  'server-response-time',
  'redirects',
  'total-byte-weight',
  'efficient-animated-content',
  'duplicated-javascript',
  'legacy-javascript',
]

export class PageSpeedProvider implements PerformanceProvider {
  readonly id = 'pagespeed'
  readonly label = 'Google PageSpeed Insights'
  readonly isDemo = false

  async configured(workspaceId?: string) {
    // PSI works without a key at a very low quota. Report that honestly rather
    // than claiming it is unavailable.
    const apiKey = await getConnectionSecret(workspaceId, 'pagespeed', 'apiKey')
    if (!apiKey) {
      return {
        state: 'CONNECTED' as const,
        detail:
          'Running without an API key. Google applies a strict unkeyed quota; add a key in Settings > Connections for production volume.',
      }
    }
    try {
      await httpJson<PsiResponse>(
        `${ENDPOINT}?url=${encodeURIComponent('https://example.com')}&strategy=mobile&category=performance&key=${apiKey}`,
        { timeoutMs: 60_000, retries: 0 },
      )
      return { state: 'CONNECTED' as const, detail: 'PageSpeed Insights API responded successfully.' }
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        // A 400 on the probe URL still proves the key was accepted.
        return { state: 'CONNECTED' as const, detail: 'API key accepted.' }
      }
      return {
        state: 'ERROR' as const,
        detail: `PageSpeed Insights error: ${(err as Error).message}`,
      }
    }
  }

  async run(
    url: string,
    strategy: PerfStrategyName,
    ctx?: { workspaceId?: string },
  ): Promise<PerfMeasurement> {
    await limiter.acquire(this.id)
    const apiKey = await getConnectionSecret(ctx?.workspaceId, 'pagespeed', 'apiKey')

    const params = new URLSearchParams({
      url,
      strategy: strategy.toLowerCase(),
      category: 'performance',
    })
    if (apiKey) params.set('key', apiKey)

    const data = await httpJson<PsiResponse>(`${ENDPOINT}?${params.toString()}`, {
      // A cold Lighthouse run genuinely can take a minute.
      timeoutMs: 90_000,
      retries: 1,
    })

    if (data.error) {
      throw new Error(`PageSpeed Insights: ${data.error.message ?? 'unknown error'}`)
    }

    const audits = data.lighthouseResult?.audits ?? {}
    const num = (id: string): number | null => {
      const v = audits[id]?.numericValue
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }

    const rawScore = data.lighthouseResult?.categories?.performance?.score
    const score =
      typeof rawScore === 'number' ? Math.round(rawScore * 100) : null

    // CrUX field data. `loadingExperience` is page-level; fall back to the
    // origin-level record only when the page itself has no data, and say so.
    const pageField = data.loadingExperience?.metrics
    const originField = data.originLoadingExperience?.metrics
    const field = pageField && Object.keys(pageField).length > 0 ? pageField : originField
    const fieldSource =
      pageField && Object.keys(pageField).length > 0 && !data.loadingExperience?.origin_fallback
        ? 'CrUX (this URL)'
        : originField
          ? 'CrUX (origin)'
          : null

    const resourceSummary = audits['resource-summary']?.details?.items ?? []
    const totalRow = resourceSummary.find((r) => r.resourceType === 'total')
    const imageRow = resourceSummary.find((r) => r.resourceType === 'image')
    const scriptRow = resourceSummary.find((r) => r.resourceType === 'script')

    const opportunities = OPPORTUNITY_IDS.flatMap((id) => {
      const a = audits[id]
      if (!a) return []
      // score === 1 means the audit passed; nothing to sell there.
      if (typeof a.score === 'number' && a.score >= 0.9) return []
      const savingsMs = a.details?.overallSavingsMs
      const savingsBytes = a.details?.overallSavingsBytes
      if (!savingsMs && !savingsBytes) return []
      return [
        {
          id,
          title: a.title ?? id,
          description: a.description,
          savingsMs: savingsMs ?? undefined,
          savingsBytes: savingsBytes ?? undefined,
        },
      ]
    })

    return {
      provider: this.id,
      isDemo: false,
      score,
      lcpMs: round(num('largest-contentful-paint')),
      fcpMs: round(num('first-contentful-paint')),
      cls: roundTo(num('cumulative-layout-shift'), 3),
      // Lab INP is not produced by PSI; only the field value is meaningful.
      inpMs: null,
      tbtMs: round(num('total-blocking-time')),
      ttfbMs: round(num('server-response-time')),
      speedIndexMs: round(num('speed-index')),

      fieldLcpMs: field?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      fieldCls:
        field?.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile !== undefined
          ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
          : null,
      fieldInpMs: field?.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
      fieldSource,

      pageWeightBytes: numberFrom(totalRow?.transferSize),
      requestCount: numberFrom(totalRow?.requestCount),
      imageBytes: numberFrom(imageRow?.transferSize),
      scriptBytes: numberFrom(scriptRow?.transferSize),
      unusedJsBytes: round(audits['unused-javascript']?.details?.overallSavingsBytes ?? null),
      unusedCssBytes: round(audits['unused-css-rules']?.details?.overallSavingsBytes ?? null),
      renderBlockingCount:
        audits['render-blocking-resources']?.details?.items?.length ?? null,
      opportunities,
    }
  }
}

function round(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

function roundTo(v: number | null, places: number): number | null {
  if (v === null || !Number.isFinite(v)) return null
  const f = 10 ** places
  return Math.round(v * f) / f
}

function numberFrom(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}
