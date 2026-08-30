import 'server-only'
import type { PerfMeasurement, PerformanceProvider, PerfStrategyName } from './types'

/**
 * Local Lighthouse provider.
 *
 * Kept as a first-class adapter because self-hosted Lighthouse is the right
 * answer at volume: no PSI quota, no per-request latency, and full control of
 * the throttling profile.
 *
 * It is *not* bundled by default — `lighthouse` plus a Chrome binary is a heavy
 * dependency. Rather than silently degrading to fabricated numbers, this
 * provider reports NOT_CONFIGURED with instructions, and the audit stage falls
 * through to PageSpeed or (explicitly) demo data.
 */
export class LighthouseProvider implements PerformanceProvider {
  readonly id = 'lighthouse'
  readonly label = 'Lighthouse (self-hosted)'
  readonly isDemo = false

  private async load(): Promise<{
    lighthouse: (...args: unknown[]) => Promise<unknown>
    launch: (...args: unknown[]) => Promise<{ port: number; kill: () => Promise<void> }>
  } | null> {
    try {
      const [lh, launcher] = await Promise.all([
        import(/* webpackIgnore: true */ 'lighthouse' as string),
        import(/* webpackIgnore: true */ 'chrome-launcher' as string),
      ])
      return {
        lighthouse: (lh as { default: (...a: unknown[]) => Promise<unknown> }).default,
        launch: (launcher as { launch: (...a: unknown[]) => Promise<{ port: number; kill: () => Promise<void> }> })
          .launch,
      }
    } catch {
      return null
    }
  }

  async configured() {
    const mod = await this.load()
    if (!mod) {
      return {
        state: 'NOT_CONFIGURED' as const,
        detail:
          'Install `lighthouse` and `chrome-launcher` to run audits locally instead of through the PageSpeed API: npm install lighthouse chrome-launcher',
      }
    }
    return { state: 'CONNECTED' as const, detail: 'Local Lighthouse is available.' }
  }

  async run(url: string, strategy: PerfStrategyName): Promise<PerfMeasurement> {
    const mod = await this.load()
    if (!mod) {
      throw new Error(
        'Lighthouse is not installed. Install lighthouse and chrome-launcher, or use the PageSpeed provider.',
      )
    }

    const chrome = await mod.launch({
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
    })

    try {
      const result = (await mod.lighthouse(
        url,
        {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['performance'],
          formFactor: strategy === 'MOBILE' ? 'mobile' : 'desktop',
          screenEmulation:
            strategy === 'MOBILE'
              ? { mobile: true, width: 390, height: 844, deviceScaleFactor: 2, disabled: false }
              : { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
        },
      )) as { lhr?: LighthouseReport }

      const lhr = result?.lhr
      if (!lhr) throw new Error('Lighthouse returned no report')

      const audits = lhr.audits ?? {}
      const num = (id: string): number | null => {
        const v = audits[id]?.numericValue
        return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
      }

      const score = lhr.categories?.performance?.score
      const totals = audits['resource-summary']?.details?.items ?? []
      const row = (type: string) => totals.find((t) => t.resourceType === type)

      return {
        provider: this.id,
        isDemo: false,
        score: typeof score === 'number' ? Math.round(score * 100) : null,
        lcpMs: num('largest-contentful-paint'),
        fcpMs: num('first-contentful-paint'),
        cls:
          typeof audits['cumulative-layout-shift']?.numericValue === 'number'
            ? Math.round(audits['cumulative-layout-shift']!.numericValue! * 1000) / 1000
            : null,
        inpMs: null,
        tbtMs: num('total-blocking-time'),
        ttfbMs: num('server-response-time'),
        speedIndexMs: num('speed-index'),
        // Local Lighthouse is a lab tool; it has no field data by definition.
        fieldLcpMs: null,
        fieldCls: null,
        fieldInpMs: null,
        fieldSource: null,
        pageWeightBytes: asNumber(row('total')?.transferSize),
        requestCount: asNumber(row('total')?.requestCount),
        imageBytes: asNumber(row('image')?.transferSize),
        scriptBytes: asNumber(row('script')?.transferSize),
        unusedJsBytes: asNumber(audits['unused-javascript']?.details?.overallSavingsBytes),
        unusedCssBytes: asNumber(audits['unused-css-rules']?.details?.overallSavingsBytes),
        renderBlockingCount: audits['render-blocking-resources']?.details?.items?.length ?? null,
        opportunities: [],
      }
    } finally {
      await chrome.kill().catch(() => {})
    }
  }
}

interface LighthouseReport {
  categories?: { performance?: { score?: number | null } }
  audits?: Record<
    string,
    {
      numericValue?: number
      details?: {
        overallSavingsBytes?: number
        items?: Array<{ resourceType?: string; transferSize?: number; requestCount?: number }>
      }
    }
  >
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}
