import 'server-only'
import { prisma } from '@/server/db/client'
import type { Prisma } from '@prisma/client'
import { crawlSite, maxPagesForDepth, type CrawlResult } from '@/server/crawler/crawl'
import { normalizeUrl } from '@/server/normalize/url'
import { runSeoAudit } from './seo'
import { runTechnicalAudit } from './technical'
import {
  findCachedMeasurement,
  runPerformanceAudit,
  selectPerformanceProvider,
} from './performance'
import { runUxAudit } from './ux'
import { BrowserUnavailableError } from './ux/browser'
import { getAIProvider, aiFindingsToIssues } from '@/server/ai'
import { parseWeights, DEFAULT_WEIGHTS, type ScoringWeights } from '@/server/scoring/weights'
import {
  businessValue,
  dataConfidence,
  evidenceStrength,
  healthFromIssues,
  leadPriority,
  redesignOpportunity,
  seoOpportunity,
  speedOpportunity,
  websiteCreationOpportunity,
  websiteHealth,
  type ScoreReason,
} from '@/server/scoring/compute'
import { recordUsage } from '@/server/usage/record'
import type { IssueDraft } from './types'
import type { JobContext } from '@/server/queue/types'
import type { PerfMeasurement, PerfStrategyName } from './performance/types'

/**
 * Audit orchestrator (§8, §31, §34).
 *
 * Stage isolation is the design centre of this file: each stage is wrapped so a
 * failure is *recorded against that stage* and the pipeline continues. A site
 * whose performance API timed out still yields SEO, UX and technical findings,
 * and finishes PARTIAL rather than being discarded.
 */

export type AuditScope = 'crawl' | 'technical' | 'seo' | 'performance' | 'ux'

export interface AuditPayload {
  businessId: string
  workspaceId: string
  depth: 'QUICK' | 'STANDARD' | 'DEEP'
  trigger: 'discovery' | 'manual' | 'recheck' | 'scheduled'
  scopes?: AuditScope[]
}

export async function runAudit(payload: AuditPayload, ctx: JobContext): Promise<void> {
  const { businessId, workspaceId, depth, trigger } = payload
  const scopes = new Set<AuditScope>(
    payload.scopes ?? ['crawl', 'technical', 'seo', 'performance', 'ux'],
  )

  const business = await prisma.business.findFirst({
    where: { id: businessId, workspaceId },
    include: {
      sources: { select: { provider: true, isDemo: true, confidence: true } },
      contacts: { select: { kind: true } },
      website: true,
    },
  })
  if (!business) throw new Error(`Business ${businessId} not found in workspace`)

  const [settings, profile] = await Promise.all([
    prisma.workspaceSettings.findUnique({ where: { workspaceId } }),
    prisma.scoringProfile.findFirst({ where: { workspaceId, isDefault: true } }),
  ])
  const weights = profile ? parseWeights(profile.weights) : DEFAULT_WEIGHTS

  const allDemo =
    business.sources.length > 0 && business.sources.every((s) => s.isDemo)

  // ── No website: nothing to audit, but there is still a lead to score ───────
  const site = business.websiteUrl ? normalizeUrl(business.websiteUrl) : null

  if (!site) {
    await scoreAndPersist({
      business,
      weights,
      audit: null,
      issues: [],
      seoHealth: null,
      uxHealth: null,
      technicalHealth: null,
      perfMobile: null,
      perfDesktop: null,
      websiteVerified: false,
      allDemo,
      // No website exists, so every website-derived domain is definitively
      // empty — this run is authoritative over all of them.
      authoritative: ALL_AUTHORITATIVE,
    })
    await prisma.business.update({
      where: { id: businessId },
      data: {
        auditStatus: 'SKIPPED',
        websiteStatus: business.hasSocial ? 'SOCIAL_ONLY' : 'NONE',
      },
    })
    ctx.log('No website — scored as a website-creation lead only')
    return
  }

  const audit = await prisma.audit.create({
    data: {
      businessId,
      depth,
      trigger,
      status: 'RUNNING',
      isDemo: allDemo,
      crawlStatus: scopes.has('crawl') ? 'PENDING' : 'SKIPPED',
      technicalStatus: scopes.has('technical') ? 'PENDING' : 'SKIPPED',
      seoStatus: scopes.has('seo') ? 'PENDING' : 'SKIPPED',
      performanceStatus: scopes.has('performance') ? 'PENDING' : 'SKIPPED',
      uxStatus: scopes.has('ux') ? 'PENDING' : 'SKIPPED',
    },
  })

  await prisma.business.update({
    where: { id: businessId },
    data: { auditStatus: 'RUNNING' },
  })

  const started = Date.now()
  const allIssues: IssueDraft[] = []
  const stageErrors: Record<string, string> = {}

  // Specific findings promoted to indexed Business columns for the §8 filters.
  const signals: AuditSignals = { ...EMPTY_SIGNALS }

  // ── Stage 1: crawl ────────────────────────────────────────────────────────
  let crawl: CrawlResult | null = null
  try {
    crawl = await crawlSite(site.href, {
      maxPages: Math.min(
        maxPagesForDepth(depth),
        settings?.maxPagesPerSite ?? maxPagesForDepth(depth),
      ),
      totalBudgetMs: depth === 'DEEP' ? 300_000 : 120_000,
    })
    if (!crawl.homeReachable) {
      const home = crawl.pages[0]
      throw new Error(
        home?.error ?? `homepage returned HTTP ${home?.status ?? 'no response'}`,
      )
    }
    await prisma.audit.update({
      where: { id: audit.id },
      data: { crawlStatus: 'OK', pagesCrawled: crawl.pages.length },
    })
  } catch (err) {
    const message = (err as Error).message
    stageErrors.crawl = message
    await prisma.audit.update({
      where: { id: audit.id },
      data: { crawlStatus: 'FAILED', crawlError: message.slice(0, 1000) },
    })
  }

  await ctx.heartbeat()

  // Persist crawled pages regardless — an unreachable site is itself a finding.
  if (crawl) {
    await prisma.crawledPage.createMany({
      data: crawl.pages.map((p) => ({
        auditId: audit.id,
        url: p.url,
        normalizedUrl: p.normalizedUrl,
        role: p.role,
        statusCode: p.status,
        redirectChain: p.redirectChain,
        contentType: p.contentType,
        bytes: p.bytes,
        loadMs: p.loadMs,
        title: p.title,
        error: p.error,
      })),
    })
  }

  const websiteReachable = crawl?.homeReachable ?? false

  // ── Stage 2: technical ────────────────────────────────────────────────────
  let technicalHealth: number | null = null
  let brokenLinkDetails: Array<{ url: string; status: number | null; reason: string | null }> = []

  if (scopes.has('technical') && crawl) {
    try {
      const tech = await runTechnicalAudit({ crawl, depth })
      brokenLinkDetails = tech.brokenLinkDetails
      allIssues.push(...tech.issues)
      signals.techNoHttps = !tech.facts.isHttps
      signals.techMixedContent = tech.facts.mixedContentCount > 0
      const health = healthFromIssues(tech.issues, weights)
      technicalHealth = health.score

      await prisma.technicalResult.create({
        data: {
          auditId: audit.id,
          health: health.score,
          opportunity: 100 - health.score,
          finalStatusCode: tech.facts.finalStatusCode,
          redirectCount: tech.facts.redirectCount,
          redirectChain: tech.facts.redirectChain,
          isHttps: tech.facts.isHttps,
          httpsRedirects: tech.facts.httpsRedirects,
          mixedContentCount: tech.facts.mixedContentCount,
          brokenLinks: tech.facts.brokenLinks,
          checkedLinks: tech.facts.checkedLinks,
          missingAssets: tech.facts.missingAssets,
          consoleErrors: 0,
          serverHeader: tech.facts.serverHeader,
          poweredBy: tech.facts.poweredBy,
        },
      })
      await prisma.audit.update({
        where: { id: audit.id },
        data: { technicalStatus: 'OK' },
      })
    } catch (err) {
      stageErrors.technical = (err as Error).message
      await prisma.audit.update({
        where: { id: audit.id },
        data: {
          technicalStatus: 'FAILED',
          technicalError: (err as Error).message.slice(0, 1000),
        },
      })
    }
  } else if (!crawl) {
    await prisma.audit.update({
      where: { id: audit.id },
      data: { technicalStatus: 'SKIPPED', technicalError: 'Crawl did not succeed' },
    })
  }

  await ctx.heartbeat()

  // ── Stage 3: SEO ──────────────────────────────────────────────────────────
  let seoHealth: number | null = null
  let seoIssueCount = 0

  if (scopes.has('seo') && crawl && websiteReachable) {
    try {
      const seo = await runSeoAudit({
        crawl,
        brokenLinks: brokenLinkDetails,
        businessName: business.name,
      })
      allIssues.push(...seo.issues)
      seoIssueCount = seo.issues.length
      signals.seoMissingTitle = !seo.facts.title
      signals.seoMissingDescription = !seo.facts.metaDescription
      signals.seoMissingH1 = seo.facts.h1Count === 0
      signals.seoNoSitemap = !seo.facts.sitemapFound
      signals.seoNoSchema = !seo.facts.hasStructuredData
      signals.seoNotIndexable = !seo.facts.isIndexable
      const health = healthFromIssues(seo.issues, weights)
      seoHealth = health.score

      await prisma.seoResult.create({
        data: {
          auditId: audit.id,
          health: health.score,
          opportunity: 100 - health.score,
          title: seo.facts.title,
          titleLength: seo.facts.titleLength,
          metaDescription: seo.facts.metaDescription,
          metaDescLength: seo.facts.metaDescLength,
          h1Count: seo.facts.h1Count,
          h1Text: seo.facts.h1Text,
          canonicalUrl: seo.facts.canonicalUrl,
          robotsTxtFound: seo.facts.robotsTxtFound,
          robotsTxtUrl: seo.facts.robotsTxtUrl,
          sitemapFound: seo.facts.sitemapFound,
          sitemapUrl: seo.facts.sitemapUrl,
          isIndexable: seo.facts.isIndexable,
          noindexReason: seo.facts.noindexReason,
          hasOpenGraph: seo.facts.hasOpenGraph,
          hasStructuredData: seo.facts.hasStructuredData,
          schemaTypes: seo.facts.schemaTypes,
          hasLocalBusinessSchema: seo.facts.hasLocalBusinessSchema,
          imagesTotal: seo.facts.imagesTotal,
          imagesMissingAlt: seo.facts.imagesMissingAlt,
          internalLinks: seo.facts.internalLinks,
          brokenInternalLinks: seo.facts.brokenInternalLinks,
          wordCount: seo.facts.wordCount,
          duplicateTitles: seo.facts.duplicateTitles,
          duplicateDescriptions: seo.facts.duplicateDescriptions,
          issueCount: seo.issues.length,
        },
      })
      await prisma.audit.update({ where: { id: audit.id }, data: { seoStatus: 'OK' } })
    } catch (err) {
      stageErrors.seo = (err as Error).message
      await prisma.audit.update({
        where: { id: audit.id },
        data: { seoStatus: 'FAILED', seoError: (err as Error).message.slice(0, 1000) },
      })
    }
  } else if (scopes.has('seo')) {
    await prisma.audit.update({
      where: { id: audit.id },
      data: { seoStatus: 'SKIPPED', seoError: 'Site was not reachable' },
    })
  }

  await ctx.heartbeat()

  // ── Stage 4: performance ──────────────────────────────────────────────────
  let perfMobile: PerfMeasurement | null = null
  let perfDesktop: PerfMeasurement | null = null

  if (scopes.has('performance') && websiteReachable) {
    try {
      const cacheHours = settings?.performanceCacheHours ?? 72
      const reuse = trigger !== 'manual'

      const cachedMobile = reuse
        ? await findCachedMeasurement(businessId, 'MOBILE', cacheHours)
        : null
      const cachedDesktop = reuse
        ? await findCachedMeasurement(businessId, 'DESKTOP', cacheHours)
        : null

      const needed: PerfStrategyName[] = []
      if (!cachedMobile) needed.push('MOBILE')
      if (!cachedDesktop) needed.push('DESKTOP')

      if (needed.length > 0) {
        const provider = await selectPerformanceProvider(allDemo, workspaceId)
        const perf = await runPerformanceAudit(site.href, provider, needed, workspaceId)
        allIssues.push(...perf.issues)

        for (const { strategy, measurement } of perf.measurements) {
          if (strategy === 'MOBILE') perfMobile = measurement
          else perfDesktop = measurement
          await persistMeasurement(audit.id, strategy, measurement)
          await recordUsage({
            workspaceId,
            provider: measurement.provider,
            operation: `performance.${strategy.toLowerCase()}`,
          })
        }
      }

      // Re-materialise cached rows so scoring sees a complete picture.
      if (cachedMobile) {
        perfMobile = fromCached(cachedMobile)
        await recordUsage({
          workspaceId,
          provider: cachedMobile.provider,
          operation: 'performance.mobile',
          cached: true,
        })
        await persistMeasurement(audit.id, 'MOBILE', perfMobile)
      }
      if (cachedDesktop) {
        perfDesktop = fromCached(cachedDesktop)
        await persistMeasurement(audit.id, 'DESKTOP', perfDesktop)
      }

      await prisma.audit.update({
        where: { id: audit.id },
        data: { performanceStatus: 'OK' },
      })
    } catch (err) {
      stageErrors.performance = (err as Error).message
      await prisma.audit.update({
        where: { id: audit.id },
        data: {
          performanceStatus: 'FAILED',
          performanceError: (err as Error).message.slice(0, 1000),
        },
      })
    }
  } else if (scopes.has('performance')) {
    await prisma.audit.update({
      where: { id: audit.id },
      data: { performanceStatus: 'SKIPPED', performanceError: 'Site was not reachable' },
    })
  }

  await ctx.heartbeat()

  // ── Stage 5: UX ───────────────────────────────────────────────────────────
  let uxHealth: number | null = null
  let uxIssueCount = 0
  let consoleErrors = 0

  if (scopes.has('ux') && websiteReachable && depth !== 'QUICK') {
    try {
      const ux = await runUxAudit({
        workspaceId,
        url: site.href,
        auditId: audit.id,
        captureScreenshots: true,
      })
      allIssues.push(...ux.issues)
      uxIssueCount = ux.issues.length
      consoleErrors = ux.facts.consoleErrors
      signals.uxNoViewport = !ux.facts.hasViewportMeta
      signals.uxHorizontalOverflow = (ux.facts.horizontalOverflowPx ?? 0) > 4
      signals.uxBrokenImages = ux.facts.brokenImages
      signals.uxAccessibilityIssues =
        ux.facts.lowContrastNodes + ux.facts.tinyTapTargets + ux.facts.missingAltCount
      signals.uxNavigationIssues = ux.facts.navIssues

      // Optional AI pass — supplementary, never decisive (§13, §44).
      let aiSummary: string | null = null
      let aiConfidence: string | null = null
      let aiAssisted = false

      const ai = await getAIProvider(workspaceId)
      if (!ai.isDemo && ux.screenshots.length > 0) {
        try {
          const review = await ai.reviewScreenshots({
            workspaceId,
            businessName: business.name,
            url: site.href,
            screenshots: ux.screenshots
              .filter((s) => s.buffer)
              .map((s) => ({ viewport: s.viewport, buffer: s.buffer! })),
            measuredFacts: ux.facts as unknown as Record<string, unknown>,
          })
          allIssues.push(...aiFindingsToIssues(review, site.href))
          aiSummary = review.summary
          aiConfidence = review.confidence
          aiAssisted = true
          await recordUsage({ workspaceId, provider: ai.id, operation: 'ux.vision' })
        } catch (err) {
          // AI failing is a non-event: the deterministic audit stands alone.
          ctx.log('AI-assisted review failed (audit continues)', err)
        }
      }

      const health = healthFromIssues(
        ux.issues.filter((i) => i.source !== 'AI_ASSISTED'),
        weights,
      )
      uxHealth = health.score

      const uxRow = await prisma.uxResult.create({
        data: {
          auditId: audit.id,
          health: health.score,
          opportunity: 100 - health.score,
          hasViewportMeta: ux.facts.hasViewportMeta,
          horizontalOverflowPx: ux.facts.horizontalOverflowPx,
          overlappingElements: ux.facts.overlappingElements,
          brokenImages: ux.facts.brokenImages,
          totalImages: ux.facts.totalImages,
          tinyTapTargets: ux.facts.tinyTapTargets,
          lowContrastNodes: ux.facts.lowContrastNodes,
          consoleErrors: ux.facts.consoleErrors,
          missingAltCount: ux.facts.missingAltCount,
          fontSizeTooSmall: ux.facts.fontSizeTooSmall,
          navIssues: ux.facts.navIssues,
          aiAssisted,
          aiSummary,
          aiConfidence,
        },
      })

      if (ux.screenshots.length > 0) {
        await prisma.screenshot.createMany({
          data: ux.screenshots.map((s) => ({
            uxResultId: uxRow.id,
            viewport: s.viewport,
            width: s.width,
            height: s.height,
            path: s.key,
            bytes: s.bytes,
          })),
        })
      }

      await prisma.audit.update({ where: { id: audit.id }, data: { uxStatus: 'OK' } })
    } catch (err) {
      const message =
        err instanceof BrowserUnavailableError
          ? `UX stage skipped — ${err.detail}`
          : (err as Error).message
      stageErrors.ux = message
      await prisma.audit.update({
        where: { id: audit.id },
        data: {
          // A missing browser is a configuration gap, not an audit failure.
          uxStatus: err instanceof BrowserUnavailableError ? 'SKIPPED' : 'FAILED',
          uxError: message.slice(0, 1000),
        },
      })
    }
  } else if (scopes.has('ux')) {
    await prisma.audit.update({
      where: { id: audit.id },
      data: {
        uxStatus: 'SKIPPED',
        uxError:
          depth === 'QUICK'
            ? 'Quick audits do not run browser-based UX checks'
            : 'Site was not reachable',
      },
    })
  }

  // Console errors are observed by the browser but belong on the technical
  // record. `updateMany` rather than `update` because a UX-only re-audit has no
  // TechnicalResult row for this audit — that is expected, not an error, and
  // `update` would throw into a bare catch that hid genuine failures.
  if (consoleErrors > 0) {
    await prisma.technicalResult.updateMany({
      where: { auditId: audit.id },
      data: { consoleErrors },
    })
  }

  // ── Persist issues ────────────────────────────────────────────────────────
  if (allIssues.length > 0) {
    await prisma.auditIssue.createMany({
      data: allIssues.map((i) => ({
        auditId: audit.id,
        type: i.type,
        category: i.category,
        severity: i.severity,
        confidence: i.confidence,
        title: i.title,
        description: i.description,
        evidence: i.evidence as Prisma.InputJsonValue,
        affectedUrl: i.affectedUrl ?? null,
        source: i.source ?? 'DETERMINISTIC',
        recommendedAction: i.recommendedAction,
      })),
    })
  }

  // ── Website record ────────────────────────────────────────────────────────
  const home = crawl?.pages.find((p) => p.role === 'home')
  await prisma.website.upsert({
    where: { businessId },
    create: {
      businessId,
      inputUrl: business.websiteUrl!,
      canonicalUrl: home?.finalUrl ?? null,
      domain: site.domain,
      isHttps: site.isHttps,
      finalStatus: home?.status ?? null,
      redirectChain: home?.redirectChain ?? [],
      status: websiteReachable ? 'REACHABLE' : 'UNREACHABLE',
      lastCheckedAt: new Date(),
    },
    update: {
      canonicalUrl: home?.finalUrl ?? null,
      finalStatus: home?.status ?? null,
      redirectChain: home?.redirectChain ?? [],
      status: websiteReachable ? 'REACHABLE' : 'UNREACHABLE',
      lastCheckedAt: new Date(),
    },
  })

  // ── Finalise ──────────────────────────────────────────────────────────────
  const failedStages = Object.keys(stageErrors)
  const status =
    failedStages.length === 0
      ? 'COMPLETED'
      : failedStages.length >= 4
        ? 'FAILED'
        : 'PARTIAL'

  const scores = await scoreAndPersist({
    business,
    weights,
    audit,
    issues: allIssues,
    seoHealth,
    uxHealth,
    technicalHealth,
    perfMobile,
    perfDesktop,
    websiteVerified: websiteReachable,
    allDemo,
    seoIssueCount,
    uxIssueCount,
    brokenLinkCount: brokenLinkDetails.length,
    signals,
    // Only the domains that actually produced a measurement may overwrite the
    // stored projection (§26). A UX-only re-audit, or a stage that failed, must
    // leave the other domains' scores and tab membership exactly as they were.
    authoritative: {
      seo: seoHealth !== null,
      ux: uxHealth !== null,
      technical: technicalHealth !== null,
      performance: perfMobile !== null || perfDesktop !== null,
    },
  })

  await prisma.audit.update({
    where: { id: audit.id },
    data: {
      status,
      completedAt: new Date(),
      durationMs: Date.now() - started,
      seoHealth,
      uxHealth,
      technicalHealth,
      perfHealthMobile: perfMobile?.score ?? null,
      perfHealthDesktop: perfDesktop?.score ?? null,
      websiteHealth: scores.websiteHealth,
      leadScore: scores.leadScore,
    },
  })

  await prisma.business.update({
    where: { id: businessId },
    data: {
      auditStatus: status,
      websiteStatus: websiteReachable ? 'REACHABLE' : 'UNREACHABLE',
      lastAuditedAt: new Date(),
      lastCrawledAt: crawl ? new Date() : undefined,
      lastSeoAuditAt: seoHealth !== null ? new Date() : undefined,
      lastPerfAuditAt: perfMobile || perfDesktop ? new Date() : undefined,
      lastUxAuditAt: uxHealth !== null ? new Date() : undefined,
    },
  })

  ctx.log(
    `audit ${status} — ${allIssues.length} issues, lead ${scores.leadScore}`,
    stageErrors,
  )
}

// ─────────────────────────────────────────────────────────────────────────────

async function persistMeasurement(
  auditId: string,
  strategy: PerfStrategyName,
  m: PerfMeasurement,
): Promise<void> {
  await prisma.performanceResult.upsert({
    where: { auditId_strategy: { auditId, strategy } },
    create: {
      auditId,
      strategy,
      provider: m.provider,
      isDemo: m.isDemo,
      score: m.score,
      lcpMs: m.lcpMs,
      fcpMs: m.fcpMs,
      cls: m.cls,
      inpMs: m.inpMs,
      tbtMs: m.tbtMs,
      ttfbMs: m.ttfbMs,
      speedIndexMs: m.speedIndexMs,
      fieldLcpMs: m.fieldLcpMs,
      fieldCls: m.fieldCls,
      fieldInpMs: m.fieldInpMs,
      fieldSource: m.fieldSource,
      pageWeightBytes: m.pageWeightBytes,
      requestCount: m.requestCount,
      imageBytes: m.imageBytes,
      scriptBytes: m.scriptBytes,
      unusedJsBytes: m.unusedJsBytes,
      unusedCssBytes: m.unusedCssBytes,
      renderBlockingCount: m.renderBlockingCount,
      opportunities: m.opportunities as unknown as Prisma.InputJsonValue,
    },
    update: {},
  })
}

function fromCached(row: {
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
}): PerfMeasurement {
  return { ...row, opportunities: [] }
}

interface ScoreArgs {
  business: {
    id: string
    name: string
    websiteStatus: string
    hasPhone: boolean
    hasEmail: boolean
    hasSocial: boolean
    hasWebsite: boolean
    rating: number | null
    reviewCount: number | null
    openingStatus: string | null
    addressLine: string | null
    latitude: number | null
    sources: Array<{ provider: string; isDemo: boolean }>
  }
  weights: ScoringWeights
  audit: { id: string } | null
  issues: IssueDraft[]
  seoHealth: number | null
  uxHealth: number | null
  technicalHealth: number | null
  perfMobile: PerfMeasurement | null
  perfDesktop: PerfMeasurement | null
  websiteVerified: boolean
  allDemo: boolean
  seoIssueCount?: number
  uxIssueCount?: number
  brokenLinkCount?: number
  signals?: AuditSignals
  /**
   * Which domains this run is entitled to overwrite (§26).
   *
   * A targeted re-audit ("just re-check the speed") must not erase the SEO
   * score from the last full audit — the denormalised columns feed every tab,
   * so nulling them silently drops the business out of tabs it still belongs in.
   * Anything not listed here is carried forward from the stored projection.
   */
  authoritative: AuthoritativeDomains
}

export interface AuthoritativeDomains {
  seo: boolean
  ux: boolean
  technical: boolean
  performance: boolean
}

/**
 * Picks each promoted signal from this run or the stored projection, per domain.
 * Written explicitly rather than by key prefix so a future signal cannot land in
 * the wrong group by accident.
 */
export function mergedSignals(
  fresh: AuditSignals,
  stored: Partial<AuditSignals> | null | undefined,
  authoritative: AuthoritativeDomains,
): AuditSignals {
  const seo = authoritative.seo || !stored
  const ux = authoritative.ux || !stored
  const tech = authoritative.technical || !stored

  return {
    seoMissingTitle: seo ? fresh.seoMissingTitle : (stored!.seoMissingTitle ?? false),
    seoMissingDescription: seo ? fresh.seoMissingDescription : (stored!.seoMissingDescription ?? false),
    seoMissingH1: seo ? fresh.seoMissingH1 : (stored!.seoMissingH1 ?? false),
    seoNoSitemap: seo ? fresh.seoNoSitemap : (stored!.seoNoSitemap ?? false),
    seoNoSchema: seo ? fresh.seoNoSchema : (stored!.seoNoSchema ?? false),
    seoNotIndexable: seo ? fresh.seoNotIndexable : (stored!.seoNotIndexable ?? false),

    uxNoViewport: ux ? fresh.uxNoViewport : (stored!.uxNoViewport ?? false),
    uxHorizontalOverflow: ux ? fresh.uxHorizontalOverflow : (stored!.uxHorizontalOverflow ?? false),
    uxBrokenImages: ux ? fresh.uxBrokenImages : (stored!.uxBrokenImages ?? 0),
    uxAccessibilityIssues: ux ? fresh.uxAccessibilityIssues : (stored!.uxAccessibilityIssues ?? 0),
    uxNavigationIssues: ux ? fresh.uxNavigationIssues : (stored!.uxNavigationIssues ?? 0),

    techNoHttps: tech ? fresh.techNoHttps : (stored!.techNoHttps ?? false),
    techMixedContent: tech ? fresh.techMixedContent : (stored!.techMixedContent ?? false),
  }
}

export const ALL_AUTHORITATIVE: AuthoritativeDomains = {
  seo: true,
  ux: true,
  technical: true,
  performance: true,
}

/** Audit findings promoted to indexed Business columns (see prisma/schema.prisma). */
export interface AuditSignals {
  seoMissingTitle: boolean
  seoMissingDescription: boolean
  seoMissingH1: boolean
  seoNoSitemap: boolean
  seoNoSchema: boolean
  seoNotIndexable: boolean
  uxNoViewport: boolean
  uxHorizontalOverflow: boolean
  uxBrokenImages: number
  uxAccessibilityIssues: number
  uxNavigationIssues: number
  techNoHttps: boolean
  techMixedContent: boolean
}

export const EMPTY_SIGNALS: AuditSignals = {
  seoMissingTitle: false,
  seoMissingDescription: false,
  seoMissingH1: false,
  seoNoSitemap: false,
  seoNoSchema: false,
  seoNotIndexable: false,
  uxNoViewport: false,
  uxHorizontalOverflow: false,
  uxBrokenImages: 0,
  uxAccessibilityIssues: 0,
  uxNavigationIssues: 0,
  techNoHttps: false,
  techMixedContent: false,
}

/**
 * Computes every score and writes the denormalised projections plus the
 * Opportunity rows. This is the single place Business.* scores are authored.
 */
async function scoreAndPersist(args: ScoreArgs) {
  const {
    business,
    weights,
    issues,
    seoHealth,
    uxHealth,
    technicalHealth,
    perfMobile,
    perfDesktop,
    websiteVerified,
    allDemo,
    authoritative,
  } = args

  // The stored projection and opportunity rows are the fallback for every
  // domain this run did not measure.
  const [stored, storedOpportunities] = await Promise.all([
    prisma.business.findUnique({
      where: { id: business.id },
      select: {
        seoHealth: true,
        uxHealth: true,
        technicalHealth: true,
        perfScoreMobile: true,
        perfScoreDesktop: true,
        lcpMobileMs: true,
        clsMobile: true,
        inpMobileMs: true,
        pageWeightBytes: true,
        seoIssueCount: true,
        uxIssueCount: true,
        technicalIssueCount: true,
        brokenLinkCount: true,
        seoMissingTitle: true,
        seoMissingDescription: true,
        seoMissingH1: true,
        seoNoSitemap: true,
        seoNoSchema: true,
        seoNotIndexable: true,
        uxNoViewport: true,
        uxHorizontalOverflow: true,
        uxBrokenImages: true,
        uxAccessibilityIssues: true,
        uxNavigationIssues: true,
        techNoHttps: true,
        techMixedContent: true,
      },
    }),
    prisma.opportunity.findMany({ where: { businessId: business.id } }),
  ])

  const storedOpp = (kind: string) => storedOpportunities.find((o) => o.kind === kind)

  const effectiveSeoHealth = authoritative.seo ? seoHealth : (seoHealth ?? stored?.seoHealth ?? null)
  const effectiveUxHealth = authoritative.ux ? uxHealth : (uxHealth ?? stored?.uxHealth ?? null)
  const effectiveTechnicalHealth = authoritative.technical
    ? technicalHealth
    : (technicalHealth ?? stored?.technicalHealth ?? null)
  const effectivePerfMobileScore = authoritative.performance
    ? (perfMobile?.score ?? null)
    : (perfMobile?.score ?? stored?.perfScoreMobile ?? null)
  const effectivePerfDesktopScore = authoritative.performance
    ? (perfDesktop?.score ?? null)
    : (perfDesktop?.score ?? stored?.perfScoreDesktop ?? null)

  const confidence = dataConfidence(
    {
      sourceCount: business.sources.length,
      hasPhone: business.hasPhone,
      hasEmail: business.hasEmail,
      hasAddress: Boolean(business.addressLine),
      hasCoordinates: business.latitude !== null,
      hasWebsite: business.hasWebsite,
      reviewCount: business.reviewCount,
      websiteVerified,
      isDemo: allDemo,
    },
    weights,
  )

  const value = businessValue({
    reviewCount: business.reviewCount,
    rating: business.rating,
    hasPhone: business.hasPhone,
    dataConfidence: confidence.score,
  })

  const ctx = { weights, businessValue: value }

  const perfComposite = effectivePerfMobileScore ?? effectivePerfDesktopScore ?? null

  const overallWebsiteHealth = websiteHealth(
    {
      seo: effectiveSeoHealth,
      performance: perfComposite,
      ux: effectiveUxHealth,
      technical: effectiveTechnicalHealth,
    },
    weights,
  )

  const creation = websiteCreationOpportunity(
    {
      websiteStatus: business.websiteStatus,
      hasSocial: business.hasSocial,
      hasPhone: business.hasPhone,
      reviewCount: business.reviewCount,
      rating: business.rating,
      isDemo: allDemo,
    },
    ctx,
  )

  /**
   * Recompute an opportunity only when this run actually measured its inputs.
   * Otherwise carry the stored verdict forward verbatim, reasons included, so
   * the profile page can still explain why it was triggered.
   */
  function carryForward(kind: string) {
    const prev = storedOpp(kind)
    return {
      score: prev?.score ?? 0,
      triggered: prev?.triggered ?? false,
      reasons: (Array.isArray(prev?.reasons) ? prev.reasons : []) as unknown as ScoreReason[],
      recomputed: false,
    }
  }

  // Redesign draws on both UX and technical findings. After a UX-only re-audit
  // the preserved technical *health* still feeds the score, but the technical
  // issues themselves are not in memory, so the evidence-volume component is
  // computed from this run's findings alone. That can shift the score by a point
  // or two versus a full audit — acceptable, and preferable to either refusing
  // to update it or re-reading every prior issue on every partial run.
  const redesign =
    authoritative.ux || authoritative.technical
      ? {
          ...redesignOpportunity(
            { uxHealth: effectiveUxHealth, technicalHealth: effectiveTechnicalHealth, issues },
            ctx,
          ),
          recomputed: true,
        }
      : carryForward('REDESIGN')

  const seo = authoritative.seo
    ? { ...seoOpportunity({ seoHealth: effectiveSeoHealth, issues }, ctx), recomputed: true }
    : carryForward('SEO')

  const speed = authoritative.performance
    ? {
        ...speedOpportunity(
          {
            mobileScore: effectivePerfMobileScore,
            desktopScore: effectivePerfDesktopScore,
            lcpMobileMs: perfMobile?.lcpMs ?? stored?.lcpMobileMs ?? null,
            clsMobile: perfMobile?.cls ?? stored?.clsMobile ?? null,
            issues,
          },
          ctx,
        ),
        recomputed: true,
      }
    : carryForward('SPEED')

  const deterministicIssues = issues.filter((i) => i.source !== 'AI_ASSISTED')

  // Evidence counts merge the same way the scores do, so a targeted re-audit
  // does not make a business look like it has fewer documented problems.
  const mergedSeoIssues = authoritative.seo
    ? (args.seoIssueCount ?? 0)
    : (stored?.seoIssueCount ?? 0)
  const mergedUxIssues = authoritative.ux
    ? (args.uxIssueCount ?? 0)
    : (stored?.uxIssueCount ?? 0)
  const mergedTechnicalIssues = authoritative.technical
    ? issues.filter((i) => i.category === 'TECHNICAL' || i.category === 'SECURITY').length
    : (stored?.technicalIssueCount ?? 0)
  const mergedBrokenLinks = authoritative.technical
    ? (args.brokenLinkCount ?? 0)
    : (stored?.brokenLinkCount ?? 0)

  const lead = leadPriority({
    opportunities: {
      websiteCreation: creation.score,
      redesign: redesign.score,
      seo: seo.score,
      speed: speed.score,
    },
    hasPhone: business.hasPhone,
    hasEmail: business.hasEmail,
    hasSocial: business.hasSocial,
    rating: business.rating,
    reviewCount: business.reviewCount,
    dataConfidence: confidence.score,
    openingStatus: business.openingStatus,
    issueCount: mergedSeoIssues + mergedUxIssues + mergedTechnicalIssues,
    isDemo: allDemo,
    weights,
  })

  // Opportunity rows: written for every kind we actually re-evaluated, so
  // "why not triggered?" stays answerable. Kinds this run did not measure keep
  // their existing row untouched.
  const rows: Array<{
    kind: 'WEBSITE_CREATION' | 'REDESIGN' | 'SEO' | 'SPEED'
    result: { score: number; triggered: boolean; reasons: ScoreReason[] }
  }> = [
    { kind: 'WEBSITE_CREATION', result: creation },
    ...(redesign.recomputed ? [{ kind: 'REDESIGN' as const, result: redesign }] : []),
    ...(seo.recomputed ? [{ kind: 'SEO' as const, result: seo }] : []),
    ...(speed.recomputed ? [{ kind: 'SPEED' as const, result: speed }] : []),
  ]

  for (const { kind, result } of rows) {
    await prisma.opportunity.upsert({
      where: { businessId_kind: { businessId: business.id, kind } },
      create: {
        businessId: business.id,
        kind,
        triggered: result.triggered,
        score: result.score,
        reasons: result.reasons as unknown as Prisma.InputJsonValue,
        confidence: allDemo ? 'LOW' : 'HIGH',
      },
      update: {
        triggered: result.triggered,
        score: result.score,
        reasons: result.reasons as unknown as Prisma.InputJsonValue,
        computedAt: new Date(),
      },
    })
  }

  await prisma.business.update({
    where: { id: business.id },
    data: {
      dataConfidence: confidence.score,
      websiteHealth: overallWebsiteHealth,
      seoHealth: effectiveSeoHealth,
      uxHealth: effectiveUxHealth,
      technicalHealth: effectiveTechnicalHealth,
      perfHealthMobile: effectivePerfMobileScore,
      perfHealthDesktop: effectivePerfDesktopScore,

      websiteCreationOpp: creation.score,
      redesignOpp: redesign.score,
      seoOpp: seo.score,
      speedOpp: speed.score,
      leadScore: lead.score,
      leadTier: lead.tier,

      needsWebsite: creation.triggered,
      needsRedesign: redesign.triggered,
      needsSeo: seo.triggered,
      needsSpeed: speed.triggered,

      perfScoreMobile: effectivePerfMobileScore,
      perfScoreDesktop: effectivePerfDesktopScore,
      lcpMobileMs: authoritative.performance
        ? (perfMobile?.lcpMs ?? null)
        : (perfMobile?.lcpMs ?? stored?.lcpMobileMs ?? null),
      clsMobile: authoritative.performance
        ? (perfMobile?.cls ?? null)
        : (perfMobile?.cls ?? stored?.clsMobile ?? null),
      inpMobileMs: authoritative.performance
        ? (perfMobile?.fieldInpMs ?? null)
        : (perfMobile?.fieldInpMs ?? stored?.inpMobileMs ?? null),
      pageWeightBytes: authoritative.performance
        ? (perfMobile?.pageWeightBytes ?? perfDesktop?.pageWeightBytes ?? null)
        : (perfMobile?.pageWeightBytes ??
           perfDesktop?.pageWeightBytes ??
           stored?.pageWeightBytes ??
           null),

      seoIssueCount: mergedSeoIssues,
      uxIssueCount: mergedUxIssues,
      technicalIssueCount: mergedTechnicalIssues,
      brokenLinkCount: mergedBrokenLinks,

      // Signals are promoted audit findings, so they follow the same rule: a
      // stage that did not run this time leaves its own signals untouched.
      ...mergedSignals(args.signals ?? EMPTY_SIGNALS, stored, authoritative),
    },
  })

  return {
    websiteHealth: overallWebsiteHealth,
    leadScore: lead.score,
    leadTier: lead.tier,
    evidence: evidenceStrength(deterministicIssues, weights),
  }
}
