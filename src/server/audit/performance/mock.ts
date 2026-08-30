import 'server-only'
import type { PerfMeasurement, PerformanceProvider, PerfStrategyName } from './types'

/**
 * Demo performance provider (§21).
 *
 * Produces deterministic, plausible numbers so the Speed tab, filters, scoring
 * and export can be exercised without a PageSpeed quota. Every value it returns
 * carries `isDemo: true` all the way to the UI badge and the export column.
 *
 * It is derived from a hash of the URL, so the same site always "measures" the
 * same — an audit trail that changed on every run would be indistinguishable
 * from a bug.
 */
export class MockPerformanceProvider implements PerformanceProvider {
  readonly id = 'mock-performance'
  readonly label = 'Demo performance data'
  readonly isDemo = true

  async configured() {
    return {
      state: 'CONNECTED' as const,
      detail: 'Always available. Produces clearly-labelled synthetic measurements only.',
    }
  }

  async run(url: string, strategy: PerfStrategyName): Promise<PerfMeasurement> {
    const seed = hash(`${url}|${strategy}`)
    const rnd = mulberry32(seed)

    // Mobile is systematically worse than desktop, as it is in reality.
    const mobilePenalty = strategy === 'MOBILE' ? 0.62 : 1
    const base = 20 + rnd() * 75
    const score = Math.round(Math.min(99, Math.max(8, base * mobilePenalty)))

    const lcpMs = Math.round((1200 + (100 - score) * 55) * (strategy === 'MOBILE' ? 1.35 : 1))
    const fcpMs = Math.round(lcpMs * (0.45 + rnd() * 0.2))
    const tbtMs = Math.round((100 - score) * (strategy === 'MOBILE' ? 12 : 5) * rnd())
    const cls = Math.round((0.01 + (100 - score) / 100 * 0.35 * rnd()) * 1000) / 1000
    const ttfbMs = Math.round(180 + (100 - score) * 12 * rnd())
    const pageWeightBytes = Math.round((600_000 + (100 - score) * 42_000) * (0.7 + rnd() * 0.8))

    return {
      provider: this.id,
      isDemo: true,
      score,
      lcpMs,
      fcpMs,
      cls,
      inpMs: null,
      tbtMs,
      ttfbMs,
      speedIndexMs: Math.round(lcpMs * 1.15),
      // A demo provider must not pretend to have field data from real users.
      fieldLcpMs: null,
      fieldCls: null,
      fieldInpMs: null,
      fieldSource: null,
      pageWeightBytes,
      requestCount: Math.round(28 + (100 - score) * 1.1),
      imageBytes: Math.round(pageWeightBytes * (0.4 + rnd() * 0.3)),
      scriptBytes: Math.round(pageWeightBytes * (0.15 + rnd() * 0.25)),
      unusedJsBytes: Math.round(pageWeightBytes * 0.12 * rnd()),
      unusedCssBytes: Math.round(pageWeightBytes * 0.05 * rnd()),
      renderBlockingCount: Math.round(rnd() * 8),
      opportunities:
        score < 70
          ? [
              {
                id: 'modern-image-formats',
                title: 'Serve images in next-gen formats',
                savingsBytes: Math.round(pageWeightBytes * 0.25),
              },
              {
                id: 'render-blocking-resources',
                title: 'Eliminate render-blocking resources',
                savingsMs: Math.round(tbtMs * 0.6),
              },
            ]
          : [],
    }
  }
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
