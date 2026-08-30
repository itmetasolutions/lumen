import 'server-only'
import * as cheerio from 'cheerio'
import { safeFetch, FetchFailure } from '@/server/crawler/fetch'
import { nameTokens } from '@/server/normalize/name'
import { normalizeUrl } from '@/server/normalize/url'

/**
 * Finds a business's website without spending any search-API quota.
 *
 * Rather than querying a paid SERP API, this derives plausible domains from the
 * business name, fetches each candidate directly, and only accepts one when the
 * page itself proves it belongs to that business — by carrying its phone number,
 * postcode, or name.
 *
 * Fetching a public website to see whose it is costs nothing, goes through the
 * same SSRF-guarded crawler as everything else, and is bounded to a handful of
 * requests per business.
 *
 * It is not exhaustive: a business whose domain bears no relation to its name
 * will not be found this way, and that is reported honestly rather than guessed.
 */

/** Country code → the TLDs businesses there actually register, best first. */
const TLDS_BY_COUNTRY: Record<string, string[]> = {
  GB: ['co.uk', 'com', 'uk'],
  IE: ['ie', 'com'],
  US: ['com', 'net'],
  CA: ['ca', 'com'],
  AU: ['com.au', 'au'],
  NZ: ['co.nz', 'nz'],
  DE: ['de', 'com'],
  FR: ['fr', 'com'],
  ES: ['es', 'com'],
  IT: ['it', 'com'],
  NL: ['nl', 'com'],
  BE: ['be', 'com'],
  PT: ['pt', 'com'],
  SE: ['se', 'com'],
  NO: ['no', 'com'],
  DK: ['dk', 'com'],
  FI: ['fi', 'com'],
  PL: ['pl', 'com'],
  CH: ['ch', 'com'],
  AT: ['at', 'com'],
  IN: ['in', 'co.in', 'com'],
  PK: ['com.pk', 'pk', 'com'],
  AE: ['ae', 'com'],
  ZA: ['co.za', 'com'],
  SG: ['com.sg', 'sg', 'com'],
  MY: ['com.my', 'my', 'com'],
  JP: ['jp', 'co.jp', 'com'],
  BR: ['com.br', 'br'],
  MX: ['com.mx', 'mx', 'com'],
}

const DEFAULT_TLDS = ['com', 'net', 'org']

/** Pages that resolve but belong to nobody. */
const PARKED_MARKERS = [
  'domain is for sale', 'buy this domain', 'domain for sale',
  'parked domain', 'this domain is parked', 'coming soon',
  'under construction', 'default web site page', 'godaddy.com/forsale',
  'sedo.com', 'hugedomains', 'account suspended', 'website expired',
]

export interface WebsiteCandidate {
  url: string
  domain: string
  score: number
  /** Why this was accepted or rejected — stored as provenance. */
  signals: string[]
}

export interface WebsiteSearchResult {
  found: WebsiteCandidate | null
  checked: string[]
  rejected: WebsiteCandidate[]
}

export interface WebsiteSearchInput {
  name: string
  countryCode?: string | null
  city?: string | null
  postalCode?: string | null
  /** Normalised digits of any known phone number — the strongest signal. */
  phoneDigits?: string | null
  /** Hard ceiling on how many candidates are fetched. */
  maxCandidates?: number
}

/**
 * Builds domain candidates from the business name.
 *
 * Deliberately conservative: four name shapes at most, so a business with a long
 * name does not generate dozens of requests.
 */
export function candidateDomains(input: WebsiteSearchInput): string[] {
  const tokens = nameTokens(input.name).filter((t) => t.length > 1)
  if (tokens.length === 0) return []

  const shapes = new Set<string>()
  shapes.add(tokens.join(''))
  if (tokens.length > 3) shapes.add(tokens.slice(0, 3).join(''))
  if (tokens.length > 2) shapes.add(tokens.slice(0, 2).join(''))
  if (tokens.length > 1) shapes.add(tokens.join('-'))

  const tlds = TLDS_BY_COUNTRY[(input.countryCode ?? '').toUpperCase()] ?? DEFAULT_TLDS

  const out: string[] = []
  for (const shape of shapes) {
    // Domain labels cap at 63 characters.
    if (shape.length < 3 || shape.length > 63) continue
    for (const tld of tlds) out.push(`${shape}.${tld}`)
  }

  return [...new Set(out)].slice(0, input.maxCandidates ?? 12)
}

function scoreCandidate(
  html: string,
  finalUrl: string,
  input: WebsiteSearchInput,
): WebsiteCandidate {
  const $ = cheerio.load(html)
  const text = `${$('title').text()} ${$('body').text()}`.toLowerCase().replace(/\s+/g, ' ')
  const digitsOnly = text.replace(/\D/g, '')

  const signals: string[] = []
  let score = 0

  // A parked or expired page is disqualifying regardless of anything else.
  const parked = PARKED_MARKERS.find((m) => text.includes(m))
  if (parked) {
    return {
      url: finalUrl,
      domain: normalizeUrl(finalUrl)?.domain ?? finalUrl,
      score: -10,
      signals: [`Parked or placeholder page ("${parked}")`],
    }
  }

  // Phone number is the strongest proof of ownership.
  if (input.phoneDigits && input.phoneDigits.length >= 7) {
    const tail = input.phoneDigits.slice(-9)
    if (digitsOnly.includes(tail)) {
      score += 5
      signals.push('Page contains the known phone number')
    }
  }

  if (input.postalCode) {
    const pc = input.postalCode.toLowerCase().replace(/\s+/g, '')
    if (pc.length >= 4 && text.replace(/\s+/g, '').includes(pc)) {
      score += 3
      signals.push('Page contains the known postcode')
    }
  }

  const tokens = nameTokens(input.name).filter((t) => t.length > 2)
  const present = tokens.filter((t) => text.includes(t))
  if (tokens.length > 0) {
    if (present.length === tokens.length) {
      score += 3
      signals.push('Page contains the full business name')
    } else if (present.length >= Math.ceil(tokens.length / 2)) {
      score += 1
      signals.push(`Page contains ${present.length}/${tokens.length} name words`)
    }
  }

  if (input.city) {
    const city = input.city.toLowerCase()
    if (city.length > 2 && text.includes(city)) {
      score += 1
      signals.push('Page mentions the business city')
    }
  }

  if (signals.length === 0) signals.push('No matching signals on the page')

  return {
    url: finalUrl,
    domain: normalizeUrl(finalUrl)?.domain ?? finalUrl,
    score,
    signals,
  }
}

/**
 * Accept threshold.
 *
 * 5 means a phone match alone qualifies, or name-plus-postcode, or
 * name-plus-city-plus-partial. A single weak signal never does — attaching the
 * wrong website to a lead sends the whole audit off to someone else's site.
 */
const ACCEPT_SCORE = 5

export async function findWebsite(input: WebsiteSearchInput): Promise<WebsiteSearchResult> {
  const candidates = candidateDomains(input)
  const checked: string[] = []
  const rejected: WebsiteCandidate[] = []

  for (const domain of candidates) {
    const url = `https://${domain}`
    checked.push(domain)

    let html: string
    let finalUrl: string
    try {
      const res = await safeFetch(url, { timeoutMs: 10_000, maxBytes: 1_500_000 })
      if (!res.ok || !res.body) continue
      html = res.body
      finalUrl = res.finalUrl
    } catch (err) {
      // A domain that does not resolve is the common case, not an error worth
      // surfacing — most generated candidates were never registered.
      if (!(err instanceof FetchFailure)) throw err
      continue
    }

    // A candidate that redirects to a social page or aggregator is not a website.
    const normalized = normalizeUrl(finalUrl)
    if (!normalized || normalized.isSocial || normalized.isAggregator) continue

    const scored = scoreCandidate(html, finalUrl, input)
    if (scored.score >= ACCEPT_SCORE) {
      return { found: scored, checked, rejected }
    }
    rejected.push(scored)
  }

  return { found: null, checked, rejected }
}
