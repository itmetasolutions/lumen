/**
 * URL and domain normalisation.
 *
 * Two jobs:
 *  1. produce a stable dedupe key for a business website (§3)
 *  2. produce a canonical crawl URL so the crawler does not fetch the same page
 *     five times under trivially different spellings (§12)
 */

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid',
  'ref', 'referrer', 'source', '_ga', '_gl', 'igshid', 'yclid', 'ttclid',
])

/** Hosts that are a social presence, not a website of one's own (§ website detection). */
const SOCIAL_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com',
  'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'yelp.com',
  'tripadvisor.com', 'foursquare.com', 'nextdoor.com', 'threads.net',
]

/** Hosts that host a business page but are not that business's own website. */
const AGGREGATOR_HOSTS = [
  'google.com', 'goo.gl', 'business.site', 'sites.google.com',
  'wixsite.com', 'weebly.com', 'godaddysites.com', 'squarespace.com',
  'yellowpages.com', 'yell.com', 'thomsonlocal.com', 'checkatrade.com',
  'trustpilot.com', 'bark.com', 'houzz.com',
]

export interface NormalizedUrl {
  href: string        // canonical, fetchable
  origin: string
  domain: string      // registrable-ish host without www
  host: string
  path: string
  isHttps: boolean
  isSocial: boolean
  isAggregator: boolean
}

export function normalizeUrl(raw: string | null | undefined): NormalizedUrl | null {
  if (!raw) return null
  let input = raw.trim()
  if (!input) return null

  // Tolerate the many shapes providers hand us: "example.com", "//example.com",
  // "www.example.com/", "HTTP://Example.com:80/Home?utm_source=x#top"
  if (input.startsWith('//')) input = `https:${input}`

  // Parse first, then decide. Attempting the parse before prepending a scheme is
  // what catches "mailto:a@b.com" — prepending https:// to it would otherwise
  // produce a valid-looking URL for host "b.com".
  let u: URL | null = null
  try {
    u = new URL(input)
  } catch {
    u = null
  }

  if (u) {
    // Something parsed with an explicit scheme; only http(s) is a website.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  } else {
    try {
      u = new URL(`https://${input}`)
    } catch {
      return null
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  }

  let host = u.hostname.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  if (!host.includes('.') || host.endsWith('.')) return null

  // Strip default ports.
  const port =
    (u.protocol === 'https:' && u.port === '443') ||
    (u.protocol === 'http:' && u.port === '80')
      ? ''
      : u.port

  // Drop tracking params, sort the rest for a stable key.
  const params = new URLSearchParams()
  const entries = Array.from(u.searchParams.entries())
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
  for (const [k, v] of entries) params.append(k, v)

  let path = u.pathname.replace(/\/{2,}/g, '/')
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  if (path === '') path = '/'

  const search = params.toString()
  const origin = `${u.protocol}//${host}${port ? `:${port}` : ''}`
  const href = `${origin}${path}${search ? `?${search}` : ''}`

  return {
    href,
    origin,
    domain: host,
    host,
    path,
    isHttps: u.protocol === 'https:',
    isSocial: SOCIAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`)),
    isAggregator: AGGREGATOR_HOSTS.some((s) => host === s || host.endsWith(`.${s}`)),
  }
}

export function extractDomain(raw: string | null | undefined): string | null {
  return normalizeUrl(raw)?.domain ?? null
}

/**
 * Same-site test used by the crawler to stay on the business's own site.
 * Treats "example.com" and "shop.example.com" as the same site.
 */
export function sameSite(a: string, b: string): boolean {
  const da = extractDomain(a)
  const db = extractDomain(b)
  if (!da || !db) return false
  if (da === db) return true
  const rootA = registrableRoot(da)
  const rootB = registrableRoot(db)
  return rootA === rootB
}

/**
 * Approximate registrable root. A full PSL would be more precise; this handles
 * the common multi-part public suffixes so "foo.co.uk" is not reduced to "co.uk".
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.za', 'org.za', 'net.za',
  'com.br', 'net.br', 'org.br',
  'co.in', 'net.in', 'org.in', 'gov.in',
  'com.sg', 'com.my', 'com.mx', 'com.tr', 'co.jp', 'or.jp', 'ne.jp',
])

export function registrableRoot(host: string): string {
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.')
  }
  return lastTwo
}

/** Resolve a possibly-relative href found in HTML against its page URL. */
export function resolveUrl(base: string, href: string): string | null {
  try {
    const u = new URL(href, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

export function isLikelySocialProfile(raw: string): boolean {
  const n = normalizeUrl(raw)
  return n?.isSocial ?? false
}

export function socialNetworkOf(raw: string): string | null {
  const n = normalizeUrl(raw)
  if (!n?.isSocial) return null
  const root = registrableRoot(n.domain)
  return root.split('.')[0] ?? null
}
