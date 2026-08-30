/**
 * The in-page measurement script.
 *
 * This function is serialised and executed inside the audited page, so it must
 * be self-contained — no imports, no closure over server variables. Everything
 * it returns is a measurement (a pixel count, a computed style, an element
 * count), which is what lets the audit produce evidence rather than opinion.
 */

export interface OverlapRecord {
  a: string
  b: string
  overlapPx: number
  rectA: { x: number; y: number; w: number; h: number }
  rectB: { x: number; y: number; w: number; h: number }
}

export interface TapTargetRecord {
  selector: string
  width: number
  height: number
  text: string
}

export interface ContrastRecord {
  selector: string
  text: string
  color: string
  background: string
  ratio: number
  fontSizePx: number
}

export interface PageMeasurements {
  viewportWidth: number
  documentScrollWidth: number
  horizontalOverflowPx: number
  overflowingSelectors: string[]

  hasViewportMeta: boolean
  viewportMetaContent: string | null
  viewportBlocksZoom: boolean

  totalImages: number
  brokenImages: Array<{ src: string; selector: string }>
  imagesMissingAlt: number

  tinyTapTargets: TapTargetRecord[]
  smallFontNodes: Array<{ selector: string; fontSizePx: number; text: string }>
  lowContrastNodes: ContrastRecord[]
  overlaps: OverlapRecord[]

  navPresent: boolean
  navLinkCount: number
  hasMobileMenuToggle: boolean
  navOverflows: boolean

  bodyTextLength: number
  usesFlash: boolean
  usesFrameset: boolean
  usesTableLayout: boolean
  hasHorizontalScrollContainer: boolean
}

/** Serialised into the page by page.evaluate. */
export function measurePage(isMobile: boolean): PageMeasurements {
  // ── helpers ───────────────────────────────────────────────────────────────
  const selectorFor = (el: Element): string => {
    if (el.id) return `#${el.id}`
    const tag = el.tagName.toLowerCase()
    const cls = (el.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join('')
    const parent = el.parentElement
    if (!parent) return `${tag}${cls}`
    const sameTag = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName,
    )
    const idx = sameTag.indexOf(el)
    return `${tag}${cls}${sameTag.length > 1 ? `:nth-of-type(${idx + 1})` : ''}`
  }

  const textOf = (el: Element): string =>
    (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)

  const parseColor = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()))
    if (parts.length < 3) return null
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
  }

  const relLuminance = (r: number, g: number, b: number): number => {
    const f = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }

  const contrastRatio = (
    fg: [number, number, number, number],
    bg: [number, number, number, number],
  ): number => {
    // Composite a translucent foreground over its background first.
    const a = fg[3]
    const r = fg[0] * a + bg[0] * (1 - a)
    const g = fg[1] * a + bg[1] * (1 - a)
    const b = fg[2] * a + bg[2] * (1 - a)
    const l1 = relLuminance(r, g, b)
    const l2 = relLuminance(bg[0], bg[1], bg[2])
    const light = Math.max(l1, l2)
    const dark = Math.min(l1, l2)
    return (light + 0.05) / (dark + 0.05)
  }

  /** Walks up until an opaque background is found — mirrors what the eye sees. */
  const effectiveBackground = (el: Element): [number, number, number, number] => {
    let node: Element | null = el
    while (node) {
      const bg = parseColor(getComputedStyle(node).backgroundColor)
      if (bg && bg[3] > 0.5) return bg
      node = node.parentElement
    }
    return [255, 255, 255, 1]
  }

  const isVisible = (el: Element): boolean => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  // ── viewport & overflow ───────────────────────────────────────────────────
  const viewportWidth = window.innerWidth
  const documentScrollWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0,
  )
  const horizontalOverflowPx = Math.max(0, documentScrollWidth - viewportWidth)

  const overflowingSelectors: string[] = []
  if (horizontalOverflowPx > 1) {
    const all = Array.from(document.querySelectorAll('body *')).slice(0, 3000)
    for (const el of all) {
      if (!isVisible(el)) continue
      const r = el.getBoundingClientRect()
      // Only report elements that themselves extend past the viewport edge.
      if (r.right > viewportWidth + 1 && r.width > 8) {
        overflowingSelectors.push(
          `${selectorFor(el)} (right edge ${Math.round(r.right)}px vs viewport ${viewportWidth}px)`,
        )
        if (overflowingSelectors.length >= 12) break
      }
    }
  }

  const viewportMeta = document.querySelector('meta[name="viewport"]')
  const viewportMetaContent = viewportMeta ? viewportMeta.getAttribute('content') : null
  const viewportBlocksZoom = Boolean(
    viewportMetaContent &&
      (/user-scalable\s*=\s*(no|0)/i.test(viewportMetaContent) ||
        /maximum-scale\s*=\s*1(\.0)?\b/i.test(viewportMetaContent)),
  )

  // ── images ────────────────────────────────────────────────────────────────
  const imgs = Array.from(document.images)
  const brokenImages: Array<{ src: string; selector: string }> = []
  let imagesMissingAlt = 0

  for (const img of imgs) {
    if (!img.hasAttribute('alt')) imagesMissingAlt++
    // complete && naturalWidth === 0 is the definitive broken-image signal.
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
      brokenImages.push({
        src: (img.currentSrc || img.src || '').slice(0, 300),
        selector: selectorFor(img),
      })
    }
  }

  // ── tap targets & font sizes ──────────────────────────────────────────────
  const MIN_TAP = 24 // WCAG 2.2 AA minimum
  const tinyTapTargets: TapTargetRecord[] = []
  const interactive = Array.from(
    document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]'),
  )

  if (isMobile) {
    for (const el of interactive) {
      if (!isVisible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < MIN_TAP || r.height < MIN_TAP) {
        tinyTapTargets.push({
          selector: selectorFor(el),
          width: Math.round(r.width),
          height: Math.round(r.height),
          text: textOf(el),
        })
        if (tinyTapTargets.length >= 25) break
      }
    }
  }

  const MIN_FONT = 12
  const smallFontNodes: Array<{ selector: string; fontSizePx: number; text: string }> = []
  const textEls = Array.from(
    document.querySelectorAll('p, span, li, a, td, div, label, h1, h2, h3, h4, h5, h6'),
  ).slice(0, 2000)

  for (const el of textEls) {
    const own = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 3,
    )
    if (!own || !isVisible(el)) continue
    const size = parseFloat(getComputedStyle(el).fontSize)
    if (Number.isFinite(size) && size < MIN_FONT) {
      smallFontNodes.push({
        selector: selectorFor(el),
        fontSizePx: Math.round(size * 10) / 10,
        text: textOf(el),
      })
      if (smallFontNodes.length >= 20) break
    }
  }

  // ── contrast ──────────────────────────────────────────────────────────────
  const lowContrastNodes: ContrastRecord[] = []
  for (const el of textEls) {
    if (lowContrastNodes.length >= 20) break
    const own = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 3,
    )
    if (!own || !isVisible(el)) continue

    const style = getComputedStyle(el)
    const fg = parseColor(style.color)
    if (!fg) continue
    const bg = effectiveBackground(el)
    const ratio = contrastRatio(fg, bg)
    const fontSize = parseFloat(style.fontSize)
    const weight = parseInt(style.fontWeight, 10) || 400
    // WCAG AA: 3:1 for large text (>=24px, or >=18.66px bold), else 4.5:1.
    const isLarge = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700)
    const required = isLarge ? 3 : 4.5

    if (ratio < required) {
      lowContrastNodes.push({
        selector: selectorFor(el),
        text: textOf(el),
        color: style.color,
        background: `rgb(${Math.round(bg[0])}, ${Math.round(bg[1])}, ${Math.round(bg[2])})`,
        ratio: Math.round(ratio * 100) / 100,
        fontSizePx: Math.round(fontSize * 10) / 10,
      })
    }
  }

  // ── overlapping interactive elements ──────────────────────────────────────
  const overlaps: OverlapRecord[] = []
  const candidates = interactive.filter(isVisible).slice(0, 120)

  for (let i = 0; i < candidates.length && overlaps.length < 12; i++) {
    const a = candidates[i]
    const ra = a.getBoundingClientRect()
    if (ra.width < 4 || ra.height < 4) continue

    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j]
      // Nested elements legitimately overlap (an icon inside a button).
      if (a.contains(b) || b.contains(a)) continue
      const rb = b.getBoundingClientRect()
      if (rb.width < 4 || rb.height < 4) continue

      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (ox > 2 && oy > 2) {
        const area = ox * oy
        const smaller = Math.min(ra.width * ra.height, rb.width * rb.height)
        // Only meaningful overlaps: at least a quarter of the smaller element.
        if (area / smaller > 0.25) {
          overlaps.push({
            a: selectorFor(a),
            b: selectorFor(b),
            overlapPx: Math.round(area),
            rectA: { x: Math.round(ra.x), y: Math.round(ra.y), w: Math.round(ra.width), h: Math.round(ra.height) },
            rectB: { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), h: Math.round(rb.height) },
          })
          break
        }
      }
    }
  }

  // ── navigation ────────────────────────────────────────────────────────────
  const nav =
    document.querySelector('nav') ??
    document.querySelector('[role="navigation"]') ??
    document.querySelector('header ul')
  const navLinks = nav ? nav.querySelectorAll('a[href]') : { length: 0 }
  const hasMobileMenuToggle = Boolean(
    document.querySelector(
      '[class*="hamburger" i], [class*="menu-toggle" i], [class*="nav-toggle" i], [aria-label*="menu" i], button[aria-expanded]',
    ),
  )
  let navOverflows = false
  if (nav && isVisible(nav)) {
    const r = nav.getBoundingClientRect()
    navOverflows = r.right > viewportWidth + 2 || nav.scrollWidth > nav.clientWidth + 2
  }

  // ── obsolete technology (only where reliably detectable) ──────────────────
  const usesFlash = Boolean(
    document.querySelector('object[type*="flash" i], embed[type*="flash" i], object[classid*="D27CDB6E" i]'),
  )
  const usesFrameset = Boolean(document.querySelector('frameset, frame'))
  const layoutTables = Array.from(document.querySelectorAll('table')).filter((t) => {
    // A table with no header cells and nested tables is a layout table.
    return t.querySelectorAll('th').length === 0 && t.querySelectorAll('table').length > 0
  })
  const usesTableLayout = layoutTables.length > 0

  const hasHorizontalScrollContainer = Array.from(
    document.querySelectorAll('body *'),
  )
    .slice(0, 1500)
    .some((el) => el.scrollWidth > el.clientWidth + 20 && el.clientWidth > 200)

  return {
    viewportWidth,
    documentScrollWidth,
    horizontalOverflowPx,
    overflowingSelectors,
    hasViewportMeta: Boolean(viewportMeta),
    viewportMetaContent,
    viewportBlocksZoom,
    totalImages: imgs.length,
    brokenImages,
    imagesMissingAlt,
    tinyTapTargets,
    smallFontNodes,
    lowContrastNodes,
    overlaps,
    navPresent: Boolean(nav),
    navLinkCount: navLinks.length,
    hasMobileMenuToggle,
    navOverflows,
    bodyTextLength: (document.body?.innerText ?? '').trim().length,
    usesFlash,
    usesFrameset,
    usesTableLayout,
    hasHorizontalScrollContainer,
  }
}
