export type PerfStrategyName = 'MOBILE' | 'DESKTOP'

/**
 * Lab and field measurements are kept apart on purpose (§4 Tab 4).
 * Lab data is a synthetic run; field data is what real visitors experienced.
 * Conflating them produces sales claims that do not survive scrutiny.
 */
export interface PerfMeasurement {
  provider: string
  isDemo: boolean

  score: number | null
  lcpMs: number | null
  fcpMs: number | null
  cls: number | null
  inpMs: number | null
  tbtMs: number | null
  ttfbMs: number | null
  speedIndexMs: number | null

  fieldLcpMs: number | null
  fieldCls: number | null
  fieldInpMs: number | null
  fieldSource: string | null

  pageWeightBytes: number | null
  requestCount: number | null
  imageBytes: number | null
  scriptBytes: number | null
  unusedJsBytes: number | null
  unusedCssBytes: number | null
  renderBlockingCount: number | null

  /** Provider-supplied improvement list, retained verbatim as evidence. */
  opportunities: Array<{
    id: string
    title: string
    description?: string
    savingsMs?: number
    savingsBytes?: number
  }>
}

export interface PerformanceProvider {
  readonly id: string
  readonly label: string
  readonly isDemo: boolean
  configured(workspaceId?: string): Promise<{ state: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR'; detail: string }>
  run(
    url: string,
    strategy: PerfStrategyName,
    ctx?: { workspaceId?: string },
  ): Promise<PerfMeasurement>
}

/** Core Web Vitals thresholds as published by Google. */
export const CWV = {
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
  fcp: { good: 1800, poor: 3000 },
  ttfb: { good: 800, poor: 1800 },
} as const

export function rateMetric(
  value: number | null,
  t: { good: number; poor: number },
): 'good' | 'needs-improvement' | 'poor' | 'unknown' {
  if (value === null || !Number.isFinite(value)) return 'unknown'
  if (value <= t.good) return 'good'
  if (value <= t.poor) return 'needs-improvement'
  return 'poor'
}
