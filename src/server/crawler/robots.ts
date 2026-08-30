import 'server-only'
import { safeFetch } from './fetch'

/**
 * robots.txt handling (§12, §30).
 *
 * We respect Disallow rules for our own user-agent and for `*`. This is a
 * deliberate product decision, not an oversight: the platform audits sites on
 * behalf of a prospective supplier, and ignoring robots.txt would make it the
 * kind of tool §30 says not to build.
 *
 * A site with no robots.txt, or one we cannot fetch, is treated as allow-all —
 * which is what the standard specifies.
 */

export interface RobotsRules {
  found: boolean
  url: string
  /** Longest-match Allow/Disallow pairs for the group that applies to us. */
  groups: Array<{ allow: string[]; disallow: string[] }>
  sitemaps: string[]
  crawlDelaySeconds: number | null
  raw: string | null
}

export async function fetchRobots(origin: string, agentToken: string): Promise<RobotsRules> {
  const url = `${origin.replace(/\/+$/, '')}/robots.txt`
  const empty: RobotsRules = {
    found: false,
    url,
    groups: [],
    sitemaps: [],
    crawlDelaySeconds: null,
    raw: null,
  }

  try {
    const res = await safeFetch(url, {
      timeoutMs: 10_000,
      acceptTypes: [], // servers serve robots.txt with wildly varying types
      maxBytes: 512 * 1024,
    })
    if (!res.ok || !res.body.trim()) return empty
    return parseRobots(res.body, url, agentToken)
  } catch {
    return empty
  }
}

export function parseRobots(
  text: string,
  url: string,
  agentToken: string,
): RobotsRules {
  const lines = text.split(/\r?\n/)
  const sitemaps: string[] = []

  // Collect every group, keyed by the agents it applies to.
  const collected: Array<{ agents: string[]; allow: string[]; disallow: string[]; delay: number | null }> = []
  let current: (typeof collected)[number] | null = null
  let lastWasAgent = false

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0]!.trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue

    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()

    if (field === 'sitemap') {
      if (value) sitemaps.push(value)
      continue
    }

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [], delay: null }
        collected.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }

    lastWasAgent = false
    if (!current) continue

    if (field === 'disallow') current.disallow.push(value)
    else if (field === 'allow') current.allow.push(value)
    else if (field === 'crawl-delay') {
      const n = Number.parseFloat(value)
      if (Number.isFinite(n)) current.delay = n
    }
  }

  const token = agentToken.toLowerCase()
  // A group naming us specifically wins over the wildcard group.
  const specific = collected.filter((g) => g.agents.some((a) => token.includes(a) && a !== '*'))
  const wildcard = collected.filter((g) => g.agents.includes('*'))
  const applicable = specific.length > 0 ? specific : wildcard

  return {
    found: true,
    url,
    groups: applicable.map((g) => ({ allow: g.allow, disallow: g.disallow })),
    sitemaps,
    crawlDelaySeconds: applicable.find((g) => g.delay !== null)?.delay ?? null,
    raw: text.slice(0, 20_000),
  }
}

/**
 * Longest-match rule, as specified: the most specific matching pattern wins,
 * and Allow beats Disallow on an equal-length tie.
 */
export function isAllowed(rules: RobotsRules, pathname: string): boolean {
  if (!rules.found || rules.groups.length === 0) return true

  let bestAllow = -1
  let bestDisallow = -1

  for (const group of rules.groups) {
    for (const p of group.allow) {
      if (matchesPattern(p, pathname)) bestAllow = Math.max(bestAllow, p.length)
    }
    for (const p of group.disallow) {
      // "Disallow:" with an empty value means allow everything.
      if (p === '') continue
      if (matchesPattern(p, pathname)) bestDisallow = Math.max(bestDisallow, p.length)
    }
  }

  if (bestDisallow < 0) return true
  return bestAllow >= bestDisallow
}

/** Supports the de-facto `*` wildcard and `$` end-anchor extensions. */
function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === '') return false
  if (!pattern.includes('*') && !pattern.includes('$')) {
    return path.startsWith(pattern)
  }
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  const re = new RegExp(`^${escaped}${anchored ? '$' : ''}`)
  return re.test(path)
}
