import 'server-only'
import dns from 'node:dns/promises'
import net from 'node:net'

/**
 * SSRF protection for the crawler (§29).
 *
 * This is the highest-risk surface in the product: the crawler fetches URLs that
 * arrived from third-party APIs and user CSV uploads. Without this guard, a
 * business record with `website = "http://169.254.169.254/latest/meta-data/"`
 * turns the audit worker into a proxy for the cloud metadata service.
 *
 * Defences, in order:
 *   1. scheme allowlist        — http/https only (no file:, gopher:, ftp:)
 *   2. port allowlist          — no 22/25/3306/6379/… pivoting
 *   3. hostname denylist       — localhost and .local/.internal names
 *   4. DNS resolution *before* connecting, with every resolved address checked
 *   5. re-validation on EVERY redirect hop (a public host may 302 to 127.0.0.1)
 */

export class BlockedUrlError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Blocked URL ${url}: ${reason}`)
    this.name = 'BlockedUrlError'
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443'])

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
])

const BLOCKED_TLD_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa', '.onion']

/** IPv4 ranges that must never be reachable from the crawler. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true // unparseable — fail closed
  }
  const [a, b] = parts as [number, number, number, number]

  if (a === 0) return true // "this network"
  if (a === 10) return true // RFC1918
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT (RFC6598)
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51) return true // TEST-NET-2
  if (a === 203 && b === 0) return true // TEST-NET-3
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]!

  if (addr === '::' || addr === '::1') return true
  // IPv4-mapped (::ffff:10.0.0.1) must be checked as IPv4.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIPv4(mapped[1]!)

  const first = addr.split(':')[0] ?? ''
  const head = Number.parseInt(first.padStart(4, '0').slice(0, 2), 16)
  if (Number.isNaN(head)) return true

  if ((head & 0xfe) === 0xfc) return true // fc00::/7 unique local
  if (first.startsWith('fe8') || first.startsWith('fe9') ||
      first.startsWith('fea') || first.startsWith('feb')) return true // fe80::/10
  if (first.startsWith('ff')) return true // multicast
  return false
}

export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip)
  if (version === 4) return isPrivateIPv4(ip)
  if (version === 6) return isPrivateIPv6(ip)
  return true // not an IP at all — fail closed
}

export interface UrlCheck {
  url: URL
  addresses: string[]
}

/**
 * Validate a single URL. Throws BlockedUrlError with a specific reason so the
 * audit can record *why* a site was skipped rather than reporting a generic failure.
 */
export async function assertPublicUrl(rawUrl: string): Promise<UrlCheck> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new BlockedUrlError(rawUrl, 'not a valid URL')
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(rawUrl, `scheme "${url.protocol}" is not allowed`)
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new BlockedUrlError(rawUrl, `port ${url.port} is not allowed`)
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new BlockedUrlError(rawUrl, `hostname "${hostname}" is not permitted`)
  }
  if (BLOCKED_TLD_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new BlockedUrlError(rawUrl, `internal hostname suffix on "${hostname}"`)
  }

  // A literal IP in the URL is checked directly — no DNS involved.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new BlockedUrlError(rawUrl, `resolves to non-public address ${hostname}`)
    }
    return { url, addresses: [hostname] }
  }

  let addresses: string[]
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true })
    addresses = records.map((r) => r.address)
  } catch (err) {
    throw new BlockedUrlError(rawUrl, `DNS lookup failed: ${(err as Error).message}`)
  }

  if (addresses.length === 0) {
    throw new BlockedUrlError(rawUrl, 'hostname does not resolve')
  }

  // Every resolved address must be public. A host with one public and one
  // private A record is rejected — the connection could pick either.
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new BlockedUrlError(rawUrl, `resolves to non-public address ${addr}`)
    }
  }

  return { url, addresses }
}

/** True when a URL passes every check — for callers that prefer a boolean. */
export async function isPublicUrl(rawUrl: string): Promise<boolean> {
  try {
    await assertPublicUrl(rawUrl)
    return true
  } catch {
    return false
  }
}
