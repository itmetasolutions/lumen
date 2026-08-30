/**
 * Entity resolution scoring (§3).
 *
 * The problem: "ABC Dental" from Google, "ABC Dental Ltd" from OSM and
 * "A.B.C. Dental Practice" from a SERP are one business. Creating three leads
 * makes the product useless; merging two genuinely different branches on the
 * same street is worse.
 *
 * Approach: strong identifiers decide on their own; everything else accumulates
 * evidence and must clear a threshold. Uncertain matches are *recorded* as
 * uncertain rather than silently merged.
 */

import { nameSimilarity } from '@/server/normalize/name'
import { phonesMatch } from '@/server/normalize/phone'
import { addressSimilarity, houseNumber, normalizeAddress } from '@/server/normalize/address'
import { haversineMeters } from '@/server/normalize/geo'

export interface MatchCandidate {
  id: string
  name: string
  normalizedName: string
  websiteDomain: string | null
  primaryPhoneNormalized: string | null
  phoneKeys: string[]
  addressLine: string | null
  postalCode: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  providerKeys: string[] // "provider:providerId"
}

export interface MatchInput {
  name: string
  normalizedName: string
  websiteDomain: string | null
  phoneKeys: string[]
  addressLine: string | null
  postalCode: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  providerKey: string | null
}

export type MatchDecision = 'MERGE' | 'REVIEW' | 'DISTINCT'

export interface MatchResult {
  score: number
  decision: MatchDecision
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  /** Human-readable signals, persisted so a merge can be explained later. */
  signals: string[]
}

/** Above this, merge automatically. */
const MERGE_THRESHOLD = 0.82
/** Between REVIEW and MERGE the record is merged but flagged lower-confidence. */
const REVIEW_THRESHOLD = 0.62

export function scoreMatch(a: MatchInput, b: MatchCandidate): MatchResult {
  const signals: string[] = []

  // ── Decisive identifier 1: the same provider record.
  if (a.providerKey && b.providerKeys.includes(a.providerKey)) {
    return {
      score: 1,
      decision: 'MERGE',
      confidence: 'HIGH',
      signals: ['Same provider record id'],
    }
  }

  const nameSim = nameSimilarity(a.name, b.name)
  const phoneHit = a.phoneKeys.some((pa) =>
    b.phoneKeys.some((pb) => phonesMatch(pa, pb)),
  )
  const domainHit =
    Boolean(a.websiteDomain) && a.websiteDomain === b.websiteDomain

  // ── Decisive identifier 2: same domain AND a recognisable name.
  // Domain alone is not enough: franchise sites and multi-branch practices share
  // one domain across genuinely distinct locations.
  if (domainHit) {
    signals.push(`Same website domain (${a.websiteDomain})`)
    if (nameSim >= 0.55) {
      signals.push(`Name similarity ${nameSim.toFixed(2)}`)
      const distinctLocation = farApart(a, b, 400)
      if (!distinctLocation) {
        return { score: 0.95, decision: 'MERGE', confidence: 'HIGH', signals }
      }
      signals.push('Coordinates over 400 m apart — likely a separate branch')
    }
  }

  // ── Decisive identifier 3: same phone AND a recognisable name.
  if (phoneHit) {
    signals.push('Matching phone number')
    if (nameSim >= 0.5) {
      signals.push(`Name similarity ${nameSim.toFixed(2)}`)
      return { score: 0.93, decision: 'MERGE', confidence: 'HIGH', signals }
    }
  }

  // ── Weighted evidence for everything else.
  let score = 0

  score += nameSim * 0.45
  if (nameSim > 0) signals.push(`Name similarity ${nameSim.toFixed(2)}`)

  if (phoneHit) score += 0.2
  if (domainHit) score += 0.2

  const distance = distanceBetween(a, b)
  if (distance !== null) {
    if (distance <= 60) {
      // Same-building proximity is among the strongest non-identifier signals.
      score += 0.25
      signals.push(`Within ${Math.round(distance)} m`)
    } else if (distance <= 250) {
      score += 0.12
      signals.push(`Within ${Math.round(distance)} m`)
    } else if (distance <= 1000) {
      score += 0.04
    } else {
      // Far apart is positive evidence *against* a match.
      score -= 0.25
      signals.push(`${(distance / 1000).toFixed(1)} km apart`)
    }
  }

  const addrSim = addressSimilarity(a.addressLine, b.addressLine)
  if (addrSim >= 0.8) {
    score += 0.15
    signals.push(`Address similarity ${addrSim.toFixed(2)}`)
  } else if (addrSim >= 0.5) {
    score += 0.07
  }

  // Same street, different house number is a strong negative — two shops a few
  // doors apart otherwise look identical to a fuzzy matcher, especially when
  // they belong to the same chain.
  const hnA = houseNumber(a.addressLine)
  const hnB = houseNumber(b.addressLine)
  if (hnA && hnB && hnA !== hnB && sameStreet(a.addressLine, b.addressLine)) {
    score -= 0.2
    signals.push(`Different building number (${hnA} vs ${hnB})`)
  }

  if (a.postalCode && b.postalCode) {
    if (a.postalCode === b.postalCode) {
      score += 0.1
      signals.push('Same postal code')
    } else {
      score -= 0.1
    }
  }

  if (a.city && b.city && a.city.toLowerCase() !== b.city.toLowerCase()) {
    score -= 0.08
  }

  score = Math.max(0, Math.min(1, score))

  const decision: MatchDecision =
    score >= MERGE_THRESHOLD ? 'MERGE' : score >= REVIEW_THRESHOLD ? 'REVIEW' : 'DISTINCT'

  const confidence: MatchResult['confidence'] =
    score >= 0.9 ? 'HIGH' : score >= REVIEW_THRESHOLD ? 'MEDIUM' : 'LOW'

  return { score, decision, confidence, signals }
}

/**
 * Compares the street portion only, with the leading building number removed —
 * "12 High Street" and "14 High Street" are the same street, and the whole
 * point of the house-number check is that they are not the same business.
 */
function sameStreet(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const street = (v: string) => normalizeAddress(v).replace(/^\d+[a-z]?\s*/, '')
  const sa = street(a)
  const sb = street(b)
  return sa.length > 0 && sa === sb
}

function distanceBetween(a: MatchInput, b: MatchCandidate): number | null {
  if (
    a.latitude === null ||
    a.longitude === null ||
    b.latitude === null ||
    b.longitude === null
  ) {
    return null
  }
  return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude)
}

function farApart(a: MatchInput, b: MatchCandidate, meters: number): boolean {
  const d = distanceBetween(a, b)
  return d !== null && d > meters
}

export const MATCH_THRESHOLDS = { MERGE_THRESHOLD, REVIEW_THRESHOLD }
