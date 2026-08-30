import { describe, it, expect } from 'vitest'
import { assertPublicUrl, isBlockedAddress, BlockedUrlError } from '@/server/crawler/ssrf'

/**
 * §29 — SSRF protection.
 *
 * The crawler consumes URLs that arrive from third-party APIs and user uploads.
 * These tests exist because a regression here turns an audit worker into an
 * open proxy for internal services.
 */

describe('address classification', () => {
  it('blocks every private and reserved IPv4 range', () => {
    const blocked = [
      '127.0.0.1', '127.1.2.3',        // loopback
      '10.0.0.1', '10.255.255.255',    // RFC1918
      '172.16.0.1', '172.31.255.255',  // RFC1918
      '192.168.1.1',                   // RFC1918
      '169.254.169.254',               // cloud metadata
      '0.0.0.0',                       // this network
      '100.64.0.1',                    // CGNAT
      '224.0.0.1',                     // multicast
      '255.255.255.255',               // broadcast
      '198.18.0.1',                    // benchmarking
    ]
    for (const ip of blocked) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true)
    }
  })

  it('allows genuinely public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1']) {
      expect(isBlockedAddress(ip), `${ip} should be allowed`).toBe(false)
    }
  })

  it('blocks IPv6 loopback, unique-local and link-local', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true)
    }
  })

  it('blocks IPv4-mapped IPv6 that points at a private address', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true)
  })

  it('fails closed on anything that is not an IP address', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true)
    expect(isBlockedAddress('')).toBe(true)
  })
})

describe('URL validation', () => {
  it('rejects non-http schemes', async () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://example.com',
      'ftp://example.com',
      'data:text/html,<script>',
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError)
    }
  })

  it('rejects non-standard ports used for internal pivoting', async () => {
    for (const url of [
      'http://example.com:22/',
      'http://example.com:3306/',
      'http://example.com:6379/',
      'http://example.com:5432/',
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError)
    }
  })

  it('rejects localhost and internal hostname suffixes', async () => {
    for (const url of [
      'http://localhost/',
      'http://metadata.google.internal/',
      'http://printer.local/',
      'http://db.internal/',
    ]) {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError)
    }
  })

  it('rejects a literal private IP without performing DNS', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /non-public address/,
    )
    await expect(assertPublicUrl('http://127.0.0.1:8080/admin')).rejects.toThrow()
  })

  it('rejects malformed URLs', async () => {
    await expect(assertPublicUrl('nonsense')).rejects.toBeInstanceOf(BlockedUrlError)
    await expect(assertPublicUrl('')).rejects.toBeInstanceOf(BlockedUrlError)
  })

  it('gives a specific reason so the audit can record why a site was skipped', async () => {
    try {
      await assertPublicUrl('http://127.0.0.1/')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedUrlError)
      expect((err as BlockedUrlError).reason).toMatch(/non-public/)
    }
  })
})
