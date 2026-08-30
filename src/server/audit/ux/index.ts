import 'server-only'
import { getStorage } from '@/server/storage'
import type { IssueDraft } from '../types'
import { launchBrowser, BrowserUnavailableError, VIEWPORTS } from './browser'
import { measurePage, type PageMeasurements } from './checks'

/**
 * UX/UI audit (§13).
 *
 * Deterministic browser measurement first, AI strictly second. Every finding
 * here names the element, the viewport and the measured value, so the sales
 * conversation is "your navigation overlaps the logo at 390px" rather than
 * "your site looks dated".
 */

export interface UxFacts {
  hasViewportMeta: boolean
  horizontalOverflowPx: number | null
  overlappingElements: number
  brokenImages: number
  totalImages: number
  tinyTapTargets: number
  lowContrastNodes: number
  consoleErrors: number
  missingAltCount: number
  fontSizeTooSmall: number
  navIssues: number
  aiAssisted: boolean
  aiSummary: string | null
  aiConfidence: string | null
}

export interface UxScreenshot {
  viewport: string
  width: number
  height: number
  key: string
  bytes: number
  /** Retained in memory only for an optional AI pass; never persisted here. */
  buffer?: Buffer
}

export interface UxOutput {
  facts: UxFacts
  issues: IssueDraft[]
  screenshots: UxScreenshot[]
  measurements: { desktop: PageMeasurements | null; mobile: PageMeasurements | null }
  consoleErrorSamples: string[]
}

export async function runUxAudit(input: {
  workspaceId?: string
  url: string
  auditId: string
  captureScreenshots: boolean
}): Promise<UxOutput> {
  const { workspaceId, url, auditId, captureScreenshots } = input

  let handle
  try {
    handle = await launchBrowser()
  } catch (err) {
    if (err instanceof BrowserUnavailableError) throw err
    throw new Error(`Could not start a browser: ${(err as Error).message}`)
  }

  const storage = await getStorage(workspaceId)
  const screenshots: UxScreenshot[] = []
  const consoleErrors: string[] = []
  /** Our own failures, kept apart from the page's console output so a
   *  diagnostic message reports the real cause rather than the site's noise. */
  const stageErrors: string[] = []
  const measurements: UxOutput['measurements'] = { desktop: null, mobile: null }

  try {
    for (const key of ['desktop', 'mobile'] as const) {
      const vp = VIEWPORTS[key]
      const context = await handle.browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.isMobile ? 2 : 1,
        isMobile: vp.isMobile,
        hasTouch: vp.isMobile,
        userAgent: vp.isMobile
          ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
          : undefined,
        ignoreHTTPSErrors: false,
      })

      // Bundlers that preserve function names (esbuild's `keepNames`, which tsx
      // enables) rewrite declarations as `__name(fn, "fn")`. That helper is
      // injected into the *serialised* function body handed to page.evaluate,
      // where it does not exist — so define a no-op in the page. Supplied as a
      // string so it cannot itself be rewritten by the same transform.
      await context.addInitScript({
        content: 'globalThis.__name = globalThis.__name || function (f) { return f }',
      })

      const page = await context.newPage()

      page.on('console', (msg) => {
        if (msg.type() === 'error' && consoleErrors.length < 40) {
          consoleErrors.push(`[${vp.name}] ${msg.text().slice(0, 300)}`)
        }
      })
      page.on('pageerror', (err) => {
        if (consoleErrors.length < 40) {
          consoleErrors.push(`[${vp.name}] Uncaught: ${err.message.slice(0, 300)}`)
        }
      })

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        // Give late-loading layout (fonts, hero images, lazy sections) a moment
        // to settle — measuring mid-load would manufacture layout findings.
        await page
          .waitForLoadState('networkidle', { timeout: 8_000 })
          .catch(() => {})
        await page.waitForTimeout(600)

        measurements[key] = (await page.evaluate(measurePage, vp.isMobile)) as PageMeasurements

        if (captureScreenshots) {
          const buffer = await page.screenshot({
            fullPage: false,
            type: 'jpeg',
            quality: 72,
          })
          const storageKey = `screenshots/${auditId}/${vp.name}.jpg`
          const stored = await storage.put(storageKey, Buffer.from(buffer), 'image/jpeg')
          screenshots.push({
            viewport: vp.name,
            width: vp.width,
            height: vp.height,
            key: stored.key,
            bytes: stored.bytes,
            buffer: Buffer.from(buffer),
          })
        }
      } catch (err) {
        // One viewport failing still leaves the other worth reporting.
        stageErrors.push(`[${vp.name}] ${(err as Error).message}`)
      } finally {
        await context.close().catch(() => {})
      }
    }
  } finally {
    await handle.close().catch(() => {})
  }

  if (!measurements.desktop && !measurements.mobile) {
    // Report *our* failure, not the site's console noise — the latter is what
    // made this hard to diagnose the first time.
    throw new Error(
      `The page could not be measured in a browser. ${stageErrors.join(' ') || consoleErrors.slice(0, 2).join(' ')}`.trim(),
    )
  }

  const { facts, issues } = buildFindings(measurements, consoleErrors, url)

  return { facts, issues, screenshots, measurements, consoleErrorSamples: consoleErrors.slice(0, 20) }
}

function buildFindings(
  m: UxOutput['measurements'],
  consoleErrors: string[],
  url: string,
): { facts: UxFacts; issues: IssueDraft[] } {
  const issues: IssueDraft[] = []
  const mobile = m.mobile
  const desktop = m.desktop
  const primary = mobile ?? desktop!

  // ── Viewport meta ──────────────────────────────────────────────────────────
  if (!primary.hasViewportMeta) {
    issues.push({
      type: 'ux.viewport.missing',
      category: 'UX',
      severity: 'CRITICAL',
      confidence: 'HIGH',
      title: 'No mobile viewport configured',
      description:
        'The page has no <meta name="viewport"> tag, so mobile browsers render it at desktop width and scale it down. Text becomes unreadable without pinch-zooming.',
      evidence: {
        selector: 'meta[name="viewport"]',
        found: false,
        documentScrollWidth: primary.documentScrollWidth,
        viewportWidth: primary.viewportWidth,
      },
      affectedUrl: url,
      recommendedAction:
        'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the document head.',
    })
  } else if (primary.viewportBlocksZoom) {
    issues.push({
      type: 'ux.viewport.zoom_blocked',
      category: 'ACCESSIBILITY',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: 'Pinch-to-zoom is disabled',
      description:
        'The viewport tag prevents users from zooming, which is a barrier for anyone with low vision.',
      evidence: {
        selector: 'meta[name="viewport"]',
        content: primary.viewportMetaContent,
      },
      affectedUrl: url,
      recommendedAction: 'Remove user-scalable=no and maximum-scale=1 from the viewport tag.',
    })
  }

  // ── Horizontal overflow (the single most common mobile defect) ─────────────
  if (mobile && mobile.horizontalOverflowPx > 4) {
    issues.push({
      type: 'ux.layout.horizontal_overflow',
      category: 'UX',
      severity: mobile.horizontalOverflowPx > 60 ? 'HIGH' : 'MEDIUM',
      confidence: 'HIGH',
      title: `Page scrolls sideways by ${mobile.horizontalOverflowPx}px on mobile`,
      description: `At a 390px viewport the document is ${mobile.documentScrollWidth}px wide, so visitors must scroll horizontally to read the page.`,
      evidence: {
        viewport: '390x844',
        viewportWidth: mobile.viewportWidth,
        documentScrollWidth: mobile.documentScrollWidth,
        overflowPx: mobile.horizontalOverflowPx,
        offendingElements: mobile.overflowingSelectors,
      },
      affectedUrl: url,
      recommendedAction:
        'Find the elements listed in the evidence and constrain them with max-width:100% or box-sizing:border-box.',
    })
  }

  // ── Broken images ──────────────────────────────────────────────────────────
  const broken = primary.brokenImages
  if (broken.length > 0) {
    issues.push({
      type: 'ux.images.broken',
      category: 'UX',
      severity: broken.length >= 3 ? 'HIGH' : 'MEDIUM',
      confidence: 'HIGH',
      title: `${broken.length} image(s) fail to load`,
      description:
        'These images render as broken placeholders in the browser. Measured after page load by checking naturalWidth === 0.',
      evidence: {
        count: broken.length,
        totalImages: primary.totalImages,
        images: broken.slice(0, 10),
      },
      affectedUrl: url,
      recommendedAction: 'Re-upload the missing files or correct the image paths listed above.',
    })
  }

  // ── Overlapping interactive elements ───────────────────────────────────────
  const overlaps = mobile?.overlaps ?? desktop?.overlaps ?? []
  if (overlaps.length > 0) {
    issues.push({
      type: 'ux.layout.overlapping_elements',
      category: 'UX',
      severity: 'HIGH',
      confidence: 'MEDIUM',
      title: `${overlaps.length} pair(s) of interactive elements overlap`,
      description:
        'Clickable elements physically cover each other, so taps land on the wrong control. Measured from bounding rectangles; nested elements are excluded.',
      evidence: {
        viewport: mobile ? '390x844' : '1440x900',
        pairs: overlaps.slice(0, 8),
      },
      affectedUrl: url,
      recommendedAction:
        'Inspect the listed selectors at this viewport and correct the positioning or z-index.',
    })
  }

  // ── Tap targets ────────────────────────────────────────────────────────────
  if (mobile && mobile.tinyTapTargets.length >= 3) {
    issues.push({
      type: 'ux.tap_targets.too_small',
      category: 'ACCESSIBILITY',
      severity: 'MEDIUM',
      confidence: 'HIGH',
      title: `${mobile.tinyTapTargets.length} tap targets are smaller than 24px`,
      description:
        'Links and buttons below roughly 24×24px are hard to hit accurately on a touch screen. WCAG 2.2 sets 24px as the minimum.',
      evidence: {
        viewport: '390x844',
        minimumPx: 24,
        count: mobile.tinyTapTargets.length,
        examples: mobile.tinyTapTargets.slice(0, 10),
      },
      affectedUrl: url,
      recommendedAction: 'Increase padding on the listed controls so their hit area reaches 24×24px.',
    })
  }

  // ── Typography ─────────────────────────────────────────────────────────────
  if (mobile && mobile.smallFontNodes.length >= 3) {
    issues.push({
      type: 'ux.typography.too_small',
      category: 'UX',
      severity: 'LOW',
      confidence: 'HIGH',
      title: `${mobile.smallFontNodes.length} text elements render below 12px on mobile`,
      description: 'Body text under 12px is difficult to read on a phone without zooming.',
      evidence: {
        viewport: '390x844',
        minimumPx: 12,
        examples: mobile.smallFontNodes.slice(0, 10),
      },
      affectedUrl: url,
      recommendedAction: 'Raise base font size to at least 16px for body copy.',
    })
  }

  // ── Contrast ───────────────────────────────────────────────────────────────
  const contrast = primary.lowContrastNodes
  if (contrast.length > 0) {
    const worst = contrast.reduce((a, b) => (a.ratio < b.ratio ? a : b))
    issues.push({
      type: 'ux.contrast.insufficient',
      category: 'ACCESSIBILITY',
      severity: contrast.length >= 5 ? 'MEDIUM' : 'LOW',
      // MEDIUM: a computed background can be wrong when text sits on an image.
      confidence: 'MEDIUM',
      title: `${contrast.length} text elements fall below WCAG AA contrast`,
      description: `The worst measured ratio is ${worst.ratio}:1 (AA requires 4.5:1 for body text, 3:1 for large text). Contrast is computed from the resolved text colour against the nearest opaque background.`,
      evidence: {
        standard: 'WCAG 2.1 AA',
        count: contrast.length,
        worst,
        examples: contrast.slice(0, 8),
      },
      affectedUrl: url,
      recommendedAction: 'Darken the text or lighten the background until each pair meets its required ratio.',
    })
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  let navIssues = 0
  if (mobile?.navOverflows) {
    navIssues++
    issues.push({
      type: 'ux.navigation.overflows',
      category: 'UX',
      severity: 'HIGH',
      confidence: 'HIGH',
      title: 'Navigation extends beyond the mobile viewport',
      description:
        'The navigation element is wider than the 390px viewport, so menu items are cut off or force sideways scrolling.',
      evidence: {
        viewport: '390x844',
        navLinkCount: mobile.navLinkCount,
        hasMobileMenuToggle: mobile.hasMobileMenuToggle,
        documentScrollWidth: mobile.documentScrollWidth,
      },
      affectedUrl: url,
      recommendedAction: 'Add a responsive menu (or collapse toggle) below the tablet breakpoint.',
    })
  }

  if (mobile && mobile.navPresent && mobile.navLinkCount >= 5 && !mobile.hasMobileMenuToggle) {
    navIssues++
    issues.push({
      type: 'ux.navigation.no_mobile_menu',
      category: 'UX',
      severity: 'MEDIUM',
      confidence: 'MEDIUM',
      title: 'No mobile menu control detected',
      description: `The navigation contains ${mobile.navLinkCount} links but no collapse toggle was found, which usually means the desktop menu is being shown on phones.`,
      evidence: {
        viewport: '390x844',
        navLinkCount: mobile.navLinkCount,
        togglesSearched: 'hamburger / menu-toggle / nav-toggle / aria-label*=menu / button[aria-expanded]',
      },
      affectedUrl: url,
      recommendedAction: 'Add a standard collapsible mobile navigation pattern.',
    })
  }

  // ── Obsolete technology ────────────────────────────────────────────────────
  if (primary.usesFlash || primary.usesFrameset) {
    issues.push({
      type: 'ux.technology.obsolete',
      category: 'TECHNICAL',
      severity: 'CRITICAL',
      confidence: 'HIGH',
      title: primary.usesFlash ? 'Page embeds Adobe Flash' : 'Page uses HTML framesets',
      description: primary.usesFlash
        ? 'Flash has been removed from every major browser since 2020; this content cannot render for any visitor.'
        : 'Framesets are obsolete, break bookmarking and deep links, and are not usable on mobile.',
      evidence: { flash: primary.usesFlash, frameset: primary.usesFrameset },
      affectedUrl: url,
      recommendedAction: 'Rebuild the affected sections with modern HTML.',
    })
  } else if (primary.usesTableLayout) {
    issues.push({
      type: 'ux.technology.table_layout',
      category: 'UX',
      severity: 'MEDIUM',
      confidence: 'MEDIUM',
      title: 'Page appears to use tables for layout',
      description:
        'Nested tables with no header cells were found, which is the signature of a pre-responsive layout. Such layouts rarely adapt to mobile.',
      evidence: { nestedLayoutTablesDetected: true },
      affectedUrl: url,
      recommendedAction: 'Rebuild the layout with CSS grid or flexbox.',
    })
  }

  // ── Console errors ─────────────────────────────────────────────────────────
  if (consoleErrors.length > 0) {
    issues.push({
      type: 'ux.console.errors',
      category: 'TECHNICAL',
      severity: consoleErrors.length >= 5 ? 'MEDIUM' : 'LOW',
      confidence: 'HIGH',
      title: `${consoleErrors.length} JavaScript error(s) in the browser console`,
      description:
        'Scripts are throwing errors while the page loads. Depending on what failed, forms, menus or booking widgets may not work.',
      evidence: { count: consoleErrors.length, samples: consoleErrors.slice(0, 10) },
      affectedUrl: url,
      recommendedAction: 'Open the browser console on this page and resolve the reported errors.',
    })
  }

  const facts: UxFacts = {
    hasViewportMeta: primary.hasViewportMeta,
    horizontalOverflowPx: mobile ? mobile.horizontalOverflowPx : null,
    overlappingElements: overlaps.length,
    brokenImages: broken.length,
    totalImages: primary.totalImages,
    tinyTapTargets: mobile?.tinyTapTargets.length ?? 0,
    lowContrastNodes: contrast.length,
    consoleErrors: consoleErrors.length,
    missingAltCount: primary.imagesMissingAlt,
    fontSizeTooSmall: mobile?.smallFontNodes.length ?? 0,
    navIssues,
    aiAssisted: false,
    aiSummary: null,
    aiConfidence: null,
  }

  return { facts, issues }
}
