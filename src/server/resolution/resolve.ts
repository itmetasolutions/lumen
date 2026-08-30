import 'server-only'
import { prisma } from '@/server/db/client'
import { geohashNeighborhood } from '@/server/normalize/geo'
import type { BusinessDraft } from '@/server/discovery/normalize'
import { scoreMatch, type MatchCandidate, type MatchInput } from './match'
import type { Prisma } from '@prisma/client'

/**
 * Resolve a normalised draft against the workspace's existing businesses and
 * either merge it into one or create a new one (§3).
 *
 * Two invariants:
 *  1. Provenance is never lost. A merge appends a BusinessSource row; it never
 *     replaces one. "Which sources agree that this phone number is right?" must
 *     remain answerable afterwards.
 *  2. Lower-confidence data never overwrites higher-confidence data (§19). It
 *     may only fill fields that are currently empty.
 */

export interface ResolveOutcome {
  businessId: string
  created: boolean
  merged: boolean
  matchScore: number
  matchSignals: string[]
  matchConfidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

/** Candidate cap per blocking key — bounds the work per draft. */
const CANDIDATE_LIMIT = 40

const CANDIDATE_SELECT = {
  id: true,
  name: true,
  normalizedName: true,
  websiteDomain: true,
  primaryPhoneNormalized: true,
  addressLine: true,
  postalCode: true,
  city: true,
  latitude: true,
  longitude: true,
  contacts: { select: { kind: true, normalized: true } },
  sources: { select: { provider: true, providerId: true, confidence: true } },
} satisfies Prisma.BusinessSelect

type CandidateRow = Prisma.BusinessGetPayload<{ select: typeof CANDIDATE_SELECT }>

function toCandidate(row: CandidateRow): MatchCandidate {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalizedName,
    websiteDomain: row.websiteDomain,
    primaryPhoneNormalized: row.primaryPhoneNormalized,
    phoneKeys: row.contacts
      .filter((c) => c.kind === 'PHONE')
      .map((c) => c.normalized),
    addressLine: row.addressLine,
    postalCode: row.postalCode,
    city: row.city,
    latitude: row.latitude,
    longitude: row.longitude,
    providerKeys: row.sources.map((s) => `${s.provider}:${s.providerId ?? ''}`),
  }
}

/**
 * Blocking: cheaply narrow millions of rows to a handful of plausible matches.
 * Each key is indexed; the union is deduplicated in memory before scoring.
 */
async function findCandidates(
  workspaceId: string,
  draft: BusinessDraft,
  providerKey: string | null,
): Promise<CandidateRow[]> {
  const phoneKeys = draft.contacts
    .filter((c) => c.kind === 'PHONE')
    .map((c) => c.normalized)

  const ors: Prisma.BusinessWhereInput[] = [
    { normalizedName: draft.normalizedName },
  ]

  if (draft.websiteDomain) ors.push({ websiteDomain: draft.websiteDomain })

  if (phoneKeys.length > 0) {
    ors.push({ primaryPhoneNormalized: { in: phoneKeys } })
    ors.push({
      contacts: { some: { kind: 'PHONE', normalized: { in: phoneKeys } } },
    })
  }

  if (draft.latitude !== null && draft.longitude !== null) {
    // Neighbourhood, not just the containing cell: a business one metre over a
    // cell boundary must still be considered.
    ors.push({
      geohash: {
        in: geohashNeighborhood(draft.latitude, draft.longitude, 6),
      },
    })
  }

  if (providerKey) {
    const [provider, id] = splitProviderKey(providerKey)
    if (id) ors.push({ sources: { some: { provider, providerId: id } } })
  }

  return prisma.business.findMany({
    where: { workspaceId, OR: ors },
    select: CANDIDATE_SELECT,
    take: CANDIDATE_LIMIT,
    orderBy: { updatedAt: 'desc' },
  })
}

function splitProviderKey(key: string): [string, string | null] {
  const idx = key.indexOf(':')
  if (idx < 0) return [key, null]
  const id = key.slice(idx + 1)
  return [key.slice(0, idx), id.length > 0 ? id : null]
}

/** Stable synthetic id so a provider without record ids still dedupes its own rows. */
function providerRecordId(draft: BusinessDraft): string {
  if (draft.providerId) return draft.providerId
  return `auto:${draft.normalizedName}|${(draft.city ?? '').toLowerCase()}|${draft.postalCode ?? ''}`
}

export async function resolveAndUpsert(
  draft: BusinessDraft,
  opts: { workspaceId: string; jobId: string | null },
): Promise<ResolveOutcome> {
  const { workspaceId, jobId } = opts
  const recordId = providerRecordId(draft)
  const providerKey = `${draft.provider}:${recordId}`

  const phoneKeys = draft.contacts
    .filter((c) => c.kind === 'PHONE')
    .map((c) => c.normalized)

  const input: MatchInput = {
    name: draft.name,
    normalizedName: draft.normalizedName,
    websiteDomain: draft.websiteDomain,
    phoneKeys,
    addressLine: draft.addressLine,
    postalCode: draft.postalCode,
    city: draft.city,
    latitude: draft.latitude,
    longitude: draft.longitude,
    providerKey,
  }

  const candidates = await findCandidates(workspaceId, draft, providerKey)

  let best: { row: CandidateRow; result: ReturnType<typeof scoreMatch> } | null = null
  for (const row of candidates) {
    const result = scoreMatch(input, toCandidate(row))
    if (result.decision === 'DISTINCT') continue
    if (!best || result.score > best.result.score) best = { row, result }
  }

  if (best) {
    await mergeIntoExisting(best.row.id, draft, { jobId, recordId })
    return {
      businessId: best.row.id,
      created: false,
      merged: true,
      matchScore: best.result.score,
      matchSignals: best.result.signals,
      matchConfidence: best.result.confidence,
    }
  }

  const businessId = await createBusiness(draft, { workspaceId, jobId, recordId })
  return {
    businessId,
    created: true,
    merged: false,
    matchScore: 0,
    matchSignals: [],
    matchConfidence: 'HIGH',
  }
}

async function createBusiness(
  draft: BusinessDraft,
  ctx: { workspaceId: string; jobId: string | null; recordId: string },
): Promise<string> {
  const primaryPhone = draft.contacts.find((c) => c.kind === 'PHONE')
  const primaryEmail = draft.contacts.find((c) => c.kind === 'EMAIL')
  const hasSocial = draft.contacts.some((c) => c.kind === 'SOCIAL')

  const business = await prisma.business.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: draft.name,
      normalizedName: draft.normalizedName,
      industry: draft.industry,
      category: draft.category,
      categories: draft.categories,

      addressLine: draft.addressLine,
      city: draft.city,
      region: draft.region,
      postalCode: draft.postalCode,
      country: draft.country,
      countryCode: draft.countryCode,
      area: draft.area,
      latitude: draft.latitude,
      longitude: draft.longitude,
      geohash: draft.geohash,

      primaryPhone: primaryPhone?.value ?? null,
      primaryPhoneNormalized: primaryPhone?.normalized ?? null,
      primaryEmail: primaryEmail?.normalized ?? null,
      websiteUrl: draft.websiteUrl,
      websiteDomain: draft.websiteDomain,

      rating: draft.rating,
      reviewCount: draft.reviewCount,
      openingStatus: draft.openingStatus,

      hasPhone: Boolean(primaryPhone),
      hasEmail: Boolean(primaryEmail),
      hasWebsite: Boolean(draft.websiteUrl),
      hasSocial,

      // Website presence is *asserted* here and *verified* by the audit stage.
      websiteStatus: draft.websiteUrl
        ? 'UNKNOWN'
        : draft.websiteIsSocialOnly
          ? 'SOCIAL_ONLY'
          : 'NONE',
      isDemo: draft.isDemo,

      sources: {
        create: {
          provider: draft.provider,
          providerId: ctx.recordId,
          sourceUrl: draft.sourceUrl,
          confidence: draft.sourceConfidence,
          isDemo: draft.isDemo,
          raw: (draft.raw ?? null) as Prisma.InputJsonValue,
          jobId: ctx.jobId,
        },
      },
      contacts: {
        create: draft.contacts.map((c) => ({
          kind: c.kind,
          value: c.value,
          normalized: c.normalized,
          label: c.label,
          isPrimary: c.label === 'primary',
          provider: draft.provider,
          sourceUrl: draft.sourceUrl,
          confidence: c.confidence,
        })),
      },
      outreach: { create: {} },
    },
    select: { id: true },
  })

  return business.id
}

async function mergeIntoExisting(
  businessId: string,
  draft: BusinessDraft,
  ctx: { jobId: string | null; recordId: string },
): Promise<void> {
  const existing = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      addressLine: true,
      city: true,
      region: true,
      postalCode: true,
      country: true,
      countryCode: true,
      area: true,
      latitude: true,
      longitude: true,
      category: true,
      categories: true,
      rating: true,
      reviewCount: true,
      openingStatus: true,
      websiteUrl: true,
      websiteDomain: true,
      websiteStatus: true,
      primaryPhone: true,
      primaryPhoneNormalized: true,
      primaryEmail: true,
      isDemo: true,
      sources: { select: { confidence: true, isDemo: true } },
      contacts: { select: { kind: true, normalized: true } },
    },
  })

  // §19: the incoming source may overwrite a populated field only if it is at
  // least as trustworthy as the best source that already contributed.
  const bestExistingConfidence = existing.sources.reduce(
    (max, s) => Math.max(max, s.confidence),
    0,
  )
  const mayOverwrite = draft.sourceConfidence >= bestExistingConfidence

  const data: Prisma.BusinessUpdateInput = { lastSeenAt: new Date() }

  const fill = <K extends keyof Prisma.BusinessUpdateInput>(
    key: K,
    current: unknown,
    incoming: unknown,
  ) => {
    if (incoming === null || incoming === undefined || incoming === '') return
    const isEmpty = current === null || current === undefined || current === ''
    if (isEmpty || mayOverwrite) {
      ;(data as Record<string, unknown>)[key as string] = incoming
    }
  }

  fill('addressLine', existing.addressLine, draft.addressLine)
  fill('city', existing.city, draft.city)
  fill('region', existing.region, draft.region)
  fill('postalCode', existing.postalCode, draft.postalCode)
  fill('country', existing.country, draft.country)
  fill('countryCode', existing.countryCode, draft.countryCode)
  fill('area', existing.area, draft.area)
  fill('category', existing.category, draft.category)
  fill('openingStatus', existing.openingStatus, draft.openingStatus)
  fill('latitude', existing.latitude, draft.latitude)
  fill('longitude', existing.longitude, draft.longitude)
  if (draft.geohash && (existing.latitude === null || mayOverwrite)) {
    data.geohash = draft.geohash
  }

  // Ratings: prefer the source that has actually seen more reviews. A provider
  // reporting 4.9 from 3 reviews should not displace 4.4 from 380.
  if (draft.rating !== null && draft.reviewCount !== null) {
    if (
      existing.reviewCount === null ||
      draft.reviewCount > existing.reviewCount ||
      (mayOverwrite && existing.rating === null)
    ) {
      data.rating = draft.rating
      data.reviewCount = draft.reviewCount
    }
  } else if (existing.rating === null && draft.rating !== null) {
    data.rating = draft.rating
    if (draft.reviewCount !== null) data.reviewCount = draft.reviewCount
  }

  // Website: a real website always beats "none". Replacing an existing URL
  // requires higher confidence, because a wrong URL sends the audit off-site.
  if (draft.websiteUrl) {
    if (!existing.websiteUrl || (mayOverwrite && existing.websiteDomain !== draft.websiteDomain)) {
      data.websiteUrl = draft.websiteUrl
      data.websiteDomain = draft.websiteDomain
      data.hasWebsite = true
      if (existing.websiteStatus === 'NONE' || existing.websiteStatus === 'SOCIAL_ONLY') {
        data.websiteStatus = 'UNKNOWN'
      }
    }
  }

  // Categories are additive — different providers taxonomise differently and
  // the union is more useful than either alone.
  const mergedCategories = Array.from(
    new Set([...existing.categories, ...draft.categories]),
  )
  if (mergedCategories.length !== existing.categories.length) {
    data.categories = mergedCategories
  }

  // Longer names usually carry more information ("ABC Dental" → "ABC Dental Practice").
  if (mayOverwrite && draft.name.length > existing.name.length + 3) {
    data.name = draft.name
    data.normalizedName = draft.normalizedName
  }

  // A business stops being demo data the moment a real source confirms it.
  if (existing.isDemo && !draft.isDemo) data.isDemo = false

  // ── Contacts: purely additive.
  const existingKeys = new Set(existing.contacts.map((c) => `${c.kind}:${c.normalized}`))
  const newContacts = draft.contacts.filter(
    (c) => !existingKeys.has(`${c.kind}:${c.normalized}`),
  )

  const firstPhone = draft.contacts.find((c) => c.kind === 'PHONE')
  const firstEmail = draft.contacts.find((c) => c.kind === 'EMAIL')

  if (!existing.primaryPhoneNormalized && firstPhone) {
    data.primaryPhone = firstPhone.value
    data.primaryPhoneNormalized = firstPhone.normalized
    data.hasPhone = true
  }
  if (!existing.primaryEmail && firstEmail) {
    data.primaryEmail = firstEmail.normalized
    data.hasEmail = true
  }
  if (newContacts.some((c) => c.kind === 'SOCIAL')) data.hasSocial = true

  await prisma.$transaction([
    prisma.business.update({ where: { id: businessId }, data }),

    // Provenance is appended, never replaced (§19).
    prisma.businessSource.upsert({
      where: {
        businessId_provider_providerId: {
          businessId,
          provider: draft.provider,
          providerId: ctx.recordId,
        },
      },
      create: {
        businessId,
        provider: draft.provider,
        providerId: ctx.recordId,
        sourceUrl: draft.sourceUrl,
        confidence: draft.sourceConfidence,
        isDemo: draft.isDemo,
        raw: (draft.raw ?? null) as Prisma.InputJsonValue,
        jobId: ctx.jobId,
      },
      update: {
        retrievedAt: new Date(),
        sourceUrl: draft.sourceUrl,
        raw: (draft.raw ?? null) as Prisma.InputJsonValue,
        jobId: ctx.jobId,
      },
    }),

    ...newContacts.map((c) =>
      prisma.businessContact.create({
        data: {
          businessId,
          kind: c.kind,
          value: c.value,
          normalized: c.normalized,
          label: c.label,
          isPrimary: false,
          provider: draft.provider,
          sourceUrl: draft.sourceUrl,
          confidence: c.confidence,
        },
      }),
    ),
  ])
}
