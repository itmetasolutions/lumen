import { describe, it, expect } from 'vitest'
import { normalizePhone, phonesMatch } from '@/server/normalize/phone'
import {
  normalizeUrl, extractDomain, sameSite, registrableRoot, resolveUrl,
} from '@/server/normalize/url'
import { normalizeName, nameSimilarity, tokenSimilarity } from '@/server/normalize/name'
import { normalizeAddress, houseNumber, normalizePostalCode } from '@/server/normalize/address'
import { geohash, haversineMeters } from '@/server/normalize/geo'
import { normalizeEmail, normalizeCountryCode } from '@/server/discovery/normalize'

describe('phone normalisation', () => {
  it('converts a UK national number to E.164 when the country is known', () => {
    const p = normalizePhone('0161 234 5678', 'GB')
    expect(p?.normalized).toBe('+441612345678')
    expect(p?.confident).toBe(true)
  })

  it('keeps an already-international number', () => {
    expect(normalizePhone('+44 161 234 5678')?.normalized).toBe('+441612345678')
  })

  it('handles the 00 international prefix', () => {
    expect(normalizePhone('0044 161 234 5678')?.normalized).toBe('+441612345678')
  })

  it('does NOT invent a country code when the country is unknown', () => {
    const p = normalizePhone('0161 234 5678')
    expect(p?.normalized).toBe('01612345678')
    expect(p?.confident).toBe(false)
  })

  it('rejects values that are not phone numbers', () => {
    expect(normalizePhone('Not Found')).toBeNull()
    expect(normalizePhone('call us')).toBeNull()
    expect(normalizePhone('123')).toBeNull()
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone(null)).toBeNull()
  })

  it('matches national and international spellings of the same number', () => {
    expect(phonesMatch('+441612345678', '01612345678')).toBe(true)
    expect(phonesMatch('+441612345678', '+441612345679')).toBe(false)
    // A short suffix must not be treated as a match.
    expect(phonesMatch('+441612345678', '5678')).toBe(false)
  })

  it('normalises a US number', () => {
    expect(normalizePhone('(212) 555-0147', 'US')?.normalized).toBe('+12125550147')
  })
})

describe('url normalisation', () => {
  it('produces one canonical form for equivalent URLs', () => {
    const forms = [
      'example.com',
      'http://example.com',
      'https://www.example.com',
      'https://www.example.com/',
      'HTTPS://WWW.EXAMPLE.COM/',
      'https://example.com:443/',
    ]
    const results = forms.map((f) => normalizeUrl(f)?.href)
    // http:// legitimately differs in scheme; the rest must collapse.
    expect(new Set(results.filter((r) => r?.startsWith('https'))).size).toBe(1)
  })

  it('strips tracking parameters and sorts the rest', () => {
    const n = normalizeUrl('https://example.com/page?utm_source=x&b=2&a=1&fbclid=y')
    expect(n?.href).toBe('https://example.com/page?a=1&b=2')
  })

  it('drops fragments and collapses duplicate slashes', () => {
    expect(normalizeUrl('https://example.com//a//b/#top')?.href).toBe(
      'https://example.com/a/b',
    )
  })

  it('identifies social profiles rather than treating them as websites', () => {
    expect(normalizeUrl('https://facebook.com/acme')?.isSocial).toBe(true)
    expect(normalizeUrl('https://www.instagram.com/acme')?.isSocial).toBe(true)
    expect(normalizeUrl('https://acme.com')?.isSocial).toBe(false)
  })

  it('identifies aggregator listings that are not the business own site', () => {
    expect(normalizeUrl('https://acme.business.site')?.isAggregator).toBe(true)
    expect(normalizeUrl('https://yell.com/biz/acme')?.isAggregator).toBe(true)
  })

  it('rejects non-http schemes and malformed input', () => {
    expect(normalizeUrl('mailto:a@b.com')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('not a url')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl(null)).toBeNull()
  })

  it('extracts the registrable root through multi-part suffixes', () => {
    expect(registrableRoot('shop.example.co.uk')).toBe('example.co.uk')
    expect(registrableRoot('example.com')).toBe('example.com')
    expect(registrableRoot('a.b.example.com')).toBe('example.com')
  })

  it('treats subdomains of one site as the same site', () => {
    expect(sameSite('https://example.com/a', 'https://shop.example.com/b')).toBe(true)
    expect(sameSite('https://example.com', 'https://other.com')).toBe(false)
  })

  it('resolves relative hrefs against the page URL', () => {
    expect(resolveUrl('https://example.com/a/b', '../c')).toBe('https://example.com/c')
    expect(resolveUrl('https://example.com/a', 'mailto:x@y.com')).toBeNull()
  })

  it('extracts domains without the www prefix', () => {
    expect(extractDomain('https://www.Example.com/path')).toBe('example.com')
  })
})

describe('name normalisation', () => {
  it('collapses legal suffixes', () => {
    expect(normalizeName('ABC Dental Ltd.')).toBe('abc dental')
    expect(normalizeName('ABC Dental Limited')).toBe('abc dental')
    expect(normalizeName('ABC Dental, LLC')).toBe('abc dental')
    expect(normalizeName('abc dental')).toBe('abc dental')
  })

  it('keeps a leading "co" that is part of the name', () => {
    expect(normalizeName('Co-op Pharmacy')).toBe('co op pharmacy')
  })

  it('strips accents and punctuation', () => {
    expect(normalizeName('Café Rouge & Co.')).toBe('cafe rouge and')
  })

  it('scores similar names highly and different ones low', () => {
    expect(nameSimilarity('ABC Dental', 'ABC Dental Ltd')).toBeGreaterThan(0.85)
    expect(nameSimilarity('ABC Dental', 'ABC Dental Practice')).toBeGreaterThan(0.6)
    expect(nameSimilarity('ABC Dental', 'XYZ Plumbing')).toBeLessThan(0.3)
  })

  it('is order-insensitive over tokens', () => {
    expect(tokenSimilarity('Manchester Dental Practice', 'Dental Practice Manchester')).toBe(1)
  })
})

describe('address normalisation', () => {
  it('canonicalises street abbreviations', () => {
    expect(normalizeAddress('12 High Street')).toBe('12 high st')
    expect(normalizeAddress('12 High St.')).toBe('12 high st')
  })

  it('extracts the house number', () => {
    expect(houseNumber('12a High Street')).toBe('12a')
    expect(houseNumber('High Street')).toBeNull()
  })

  it('normalises postcodes and collapses ZIP+4', () => {
    expect(normalizePostalCode('m20 2rn', 'GB')).toBe('M202RN')
    expect(normalizePostalCode('90210-1234', 'US')).toBe('90210')
  })
})

describe('geo helpers', () => {
  it('measures distance between two points', () => {
    // Manchester to London is roughly 262 km.
    const d = haversineMeters(53.4808, -2.2426, 51.5074, -0.1278)
    expect(d).toBeGreaterThan(255_000)
    expect(d).toBeLessThan(270_000)
  })

  it('produces a stable geohash that shares a prefix for nearby points', () => {
    const a = geohash(53.4808, -2.2426, 6)
    const b = geohash(53.4809, -2.2427, 6)
    expect(a).toBe(b)
    expect(geohash(51.5074, -0.1278, 6)).not.toBe(a)
  })
})

describe('email and country normalisation', () => {
  it('accepts real addresses and rejects junk', () => {
    expect(normalizeEmail('Hello@Example.com')).toBe('hello@example.com')
    expect(normalizeEmail('mailto:hi@acme.co.uk')).toBe('hi@acme.co.uk')
    expect(normalizeEmail('not-an-email')).toBeNull()
    expect(normalizeEmail('a@b')).toBeNull()
    expect(normalizeEmail('info@example.com')).toBeNull() // template placeholder
  })

  it('maps country names to ISO codes', () => {
    expect(normalizeCountryCode('United Kingdom')).toBe('GB')
    expect(normalizeCountryCode('gb')).toBe('GB')
    expect(normalizeCountryCode('Atlantis')).toBeNull()
  })
})
