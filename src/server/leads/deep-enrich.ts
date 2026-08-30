import 'server-only'
import { prisma } from '@/server/db/client'
import type { Prisma } from '@prisma/client'
import { crawlSite } from '@/server/crawler/crawl'
import { normalizeUrl } from '@/server/normalize/url'
import { normalizePhone } from '@/server/normalize/phone'
import { normalizeEmail } from '@/server/discovery/normalize'
import { getQueue } from '@/server/queue'
import { extractContactsFromCrawl, type EnrichmentContact } from './contact-enrichment'
import { extractStructuredData, socialLabel } from './structured-data'
import { findWebsite } from './website-finder'
import { matchYelpBusiness } from '@/server/discovery/providers/yelp-fusion'
import { getConnectionBundle } from '@/server/settings/connections'

/**
 * Deep enrichment for a single business.
 *
 * Runs on demand from the business profile, for the case where a record is
 * missing contact details or a website entirely.
 *
 * Every step here is free: it fetches candidate domains and the business's own
 * website, both of which cost nothing and go through the SSRF-guarded, robots-
 * respecting crawler. It never calls a paid search API. Yelp Fusion is used only
 * when a key is configured, and its free tier is 500 calls a day.
 *
 * It fills gaps only — an existing value is never overwritten, because a
 * confirmed detail from a discovery provider outranks anything inferred here.
 */

export type DeepEnrichStepStatus = 'ok' | 'skipped' | 'failed' | 'not-found'

export interface DeepEnrichStep {
  step: string
  status: DeepEnrichStepStatus
  detail: string
}

export interface DeepEnrichResult {
  businessId: string
  name: string
  steps: DeepEnrichStep[]
  websiteFound: string | null
  contactsAdded: number
  phonesAdded: number
  emailsAdded: number
  socialsAdded: number
  fieldsFilled: string[]
  auditQueued: boolean
}

const ENRICH_PROVIDER = 'website-crawl'
const SCHEMA_PROVIDER = 'schema-org'
const YELP_PROVIDER = 'yelp-fusion'

export async function deepEnrichBusiness(input: {
  workspaceId: string
  businessId: string
  /** Yelp Fusion is free but rate-limited; callers may opt out. */
  useYelp?: boolean
}): Promise<DeepEnrichResult> {
  const business = await prisma.business.findFirst({
    where: { id: input.businessId, workspaceId: input.workspaceId },
    include: { contacts: { select: { kind: true, normalized: true } } },
  })
  if (!business) throw new Error('Business not found in this workspace')

  const steps: DeepEnrichStep[] = []
  const result: DeepEnrichResult = {
    businessId: business.id,
    name: business.name,
    steps,
    websiteFound: null,
    contactsAdded: 0,
    phonesAdded: 0,
    emailsAdded: 0,
    socialsAdded: 0,
    fieldsFilled: [],
    auditQueued: false,
  }

  const existingKeys = new Set(business.contacts.map((c) => `${c.kind}:${c.normalized}`))
  const pending = new Map<string, EnrichmentContact & { provider: string }>()

  const addContact = (
    contact: EnrichmentContact,
    provider: string,
  ): void => {
    const key = `${contact.kind}:${contact.normalized}`
    if (existingKeys.has(key) || pending.has(key)) return
    pending.set(key, { ...contact, provider })
  }

  // ── 1. Website ─────────────────────────────────────────────────────────────
  let websiteUrl = business.websiteUrl

  if (websiteUrl) {
    steps.push({ step: 'Website', status: 'skipped', detail: `Already known: ${business.websiteDomain}` })
  } else {
    try {
      const search = await findWebsite({
        name: business.name,
        countryCode: business.countryCode,
        city: business.city,
        postalCode: business.postalCode,
        phoneDigits: business.primaryPhoneNormalized?.replace(/\D/g, '') ?? null,
      })

      if (search.found) {
        websiteUrl = search.found.url
        result.websiteFound = search.found.url
        steps.push({
          step: 'Website search',
          status: 'ok',
          detail: `Found ${search.found.domain} — ${search.found.signals.join('; ')}`,
        })
      } else {
        steps.push({
          step: 'Website search',
          status: 'not-found',
          detail: `Checked ${search.checked.length} candidate domain(s); none could be confirmed as this business.`,
        })
      }
    } catch (err) {
      steps.push({ step: 'Website search', status: 'failed', detail: (err as Error).message })
    }
  }

  // ── 2. Crawl the site and read everything on it ────────────────────────────
  if (websiteUrl) {
    try {
      const crawl = await crawlSite(websiteUrl, {
        // Deeper than the bulk pass: this is one business the user asked about.
        maxPages: 10,
        timeoutMsPerPage: 12_000,
        totalBudgetMs: 90_000,
        delayMs: 400,
      })

      if (!crawl.homeReachable) {
        steps.push({
          step: 'Website crawl',
          status: 'failed',
          detail: crawl.pages[0]?.error ?? 'The site did not respond.',
        })
      } else {
        for (const contact of extractContactsFromCrawl(crawl, business.countryCode)) {
          addContact(contact, ENRICH_PROVIDER)
        }
        steps.push({
          step: 'Website crawl',
          status: 'ok',
          detail: `Read ${crawl.pages.length} page(s) on ${normalizeUrl(websiteUrl)?.domain}`,
        })

        // ── 3. schema.org structured data ────────────────────────────────────
        const structured = extractStructuredData(crawl, business.countryCode)
        let structuredFound = 0

        for (const phone of structured.phones) {
          const p = normalizePhone(phone, business.countryCode)
          if (!p) continue
          addContact(
            { kind: 'PHONE', value: p.display, normalized: p.normalized, label: null, sourceUrl: structured.sourceUrl ?? websiteUrl, confidence: 82 },
            SCHEMA_PROVIDER,
          )
          structuredFound++
        }
        for (const email of structured.emails) {
          const e = normalizeEmail(email)
          if (!e) continue
          addContact(
            { kind: 'EMAIL', value: e, normalized: e, label: null, sourceUrl: structured.sourceUrl ?? websiteUrl, confidence: 82 },
            SCHEMA_PROVIDER,
          )
          structuredFound++
        }
        for (const social of structured.socials) {
          addContact(
            { kind: 'SOCIAL', value: social, normalized: social, label: socialLabel(social), sourceUrl: structured.sourceUrl ?? websiteUrl, confidence: 82 },
            SCHEMA_PROVIDER,
          )
          structuredFound++
        }

        // Structured data can also fill business fields that are blank.
        const fill: Prisma.BusinessUpdateInput = {}
        if (!business.addressLine && structured.addressLine) { fill.addressLine = structured.addressLine; result.fieldsFilled.push('address') }
        if (!business.city && structured.city) { fill.city = structured.city; result.fieldsFilled.push('city') }
        if (!business.postalCode && structured.postalCode) { fill.postalCode = structured.postalCode; result.fieldsFilled.push('postcode') }
        if (business.latitude === null && structured.latitude !== null) {
          fill.latitude = structured.latitude
          fill.longitude = structured.longitude
          result.fieldsFilled.push('coordinates')
        }
        if (Object.keys(fill).length > 0) {
          await prisma.business.update({ where: { id: business.id }, data: fill })
        }

        steps.push({
          step: 'Structured data (schema.org)',
          status: structured.schemaTypes.length > 0 ? 'ok' : 'not-found',
          detail: structured.schemaTypes.length > 0
            ? `${structured.schemaTypes.join(', ')} — ${structuredFound} contact value(s)${structured.openingHours.length ? `, ${structured.openingHours.length} opening-hours entries` : ''}${structured.priceRange ? `, price range ${structured.priceRange}` : ''}`
            : 'The site publishes no schema.org business data.',
        })
      }
    } catch (err) {
      steps.push({ step: 'Website crawl', status: 'failed', detail: (err as Error).message })
    }
  } else {
    steps.push({ step: 'Website crawl', status: 'skipped', detail: 'No website to crawl.' })
  }

  // ── 4. Yelp Fusion (free tier, only when configured) ───────────────────────
  const yelpEnabled = input.useYelp !== false && (await yelpConfigured(input.workspaceId))

  if (!yelpEnabled) {
    steps.push({
      step: 'Yelp Fusion',
      status: 'skipped',
      detail: 'No Yelp Fusion key configured. Add one free in Settings → Connections.',
    })
  } else {
    try {
      const match = await matchYelpBusiness({
        workspaceId: input.workspaceId,
        name: business.name,
        addressLine: business.addressLine,
        city: business.city,
        state: business.region,
        country: business.countryCode,
        latitude: business.latitude,
        longitude: business.longitude,
      })

      if (!match) {
        steps.push({ step: 'Yelp Fusion', status: 'not-found', detail: 'No confident Yelp match for this business.' })
      } else {
        for (const phone of match.business.phones ?? []) {
          const p = normalizePhone(phone, business.countryCode)
          if (!p) continue
          addContact(
            { kind: 'PHONE', value: p.display, normalized: p.normalized, label: null, sourceUrl: match.yelpUrl, confidence: 85 },
            YELP_PROVIDER,
          )
        }
        if (!websiteUrl && match.business.website) {
          const n = normalizeUrl(match.business.website)
          if (n && !n.isSocial && !n.isAggregator) {
            websiteUrl = n.href
            result.websiteFound = n.href
          }
        }

        await prisma.businessSource.upsert({
          where: {
            businessId_provider_providerId: {
              businessId: business.id,
              provider: YELP_PROVIDER,
              providerId: match.business.providerId ?? `auto:${business.normalizedName}`,
            },
          },
          create: {
            businessId: business.id,
            provider: YELP_PROVIDER,
            providerId: match.business.providerId ?? `auto:${business.normalizedName}`,
            sourceUrl: match.yelpUrl,
            confidence: 85,
            raw: match.business.raw as Prisma.InputJsonValue,
          },
          update: { retrievedAt: new Date(), sourceUrl: match.yelpUrl },
        })

        steps.push({
          step: 'Yelp Fusion',
          status: 'ok',
          detail: `Matched${match.priceRange ? ` (price range ${match.priceRange})` : ''}${match.business.rating !== null ? `, ${match.business.rating}★ from ${match.business.reviewCount ?? 0} reviews` : ''}`,
        })
      }
    } catch (err) {
      steps.push({ step: 'Yelp Fusion', status: 'failed', detail: (err as Error).message })
    }
  }

  // ── 5. Persist ─────────────────────────────────────────────────────────────
  const contacts = [...pending.values()]

  if (contacts.length > 0) {
    const created = await prisma.businessContact.createMany({
      data: contacts.map((c) => ({
        businessId: business.id,
        kind: c.kind,
        value: c.value,
        normalized: c.normalized,
        label: c.label,
        provider: c.provider,
        sourceUrl: c.sourceUrl,
        confidence: c.confidence,
        verifiedAt: new Date(),
      })),
      skipDuplicates: true,
    })
    result.contactsAdded = created.count
    result.phonesAdded = contacts.filter((c) => c.kind === 'PHONE').length
    result.emailsAdded = contacts.filter((c) => c.kind === 'EMAIL').length
    result.socialsAdded = contacts.filter((c) => c.kind === 'SOCIAL').length
  }

  const firstPhone = contacts.find((c) => c.kind === 'PHONE')
  const firstEmail = contacts.find((c) => c.kind === 'EMAIL')
  const site = websiteUrl ? normalizeUrl(websiteUrl) : null

  await prisma.business.update({
    where: { id: business.id },
    data: {
      ...(site && !business.websiteUrl
        ? {
            websiteUrl: site.href,
            websiteDomain: site.domain,
            hasWebsite: true,
            // Reachability is confirmed by the audit, not asserted here.
            websiteStatus: 'UNKNOWN' as const,
          }
        : {}),
      ...(firstPhone && !business.primaryPhone
        ? { primaryPhone: firstPhone.value, primaryPhoneNormalized: firstPhone.normalized }
        : {}),
      ...(firstEmail && !business.primaryEmail ? { primaryEmail: firstEmail.normalized } : {}),
      hasPhone: business.hasPhone || contacts.some((c) => c.kind === 'PHONE'),
      hasEmail: business.hasEmail || contacts.some((c) => c.kind === 'EMAIL'),
      hasSocial: business.hasSocial || contacts.some((c) => c.kind === 'SOCIAL'),
      lastCrawledAt: new Date(),
      lastSeenAt: new Date(),
      contactsEnrichedAt: new Date(),
    },
  })

  if (site && !business.websiteUrl) result.fieldsFilled.push('website')
  if (firstPhone && !business.primaryPhone) result.fieldsFilled.push('phone')
  if (firstEmail && !business.primaryEmail) result.fieldsFilled.push('email')

  // ── 6. A newly-found website deserves an audit ─────────────────────────────
  if (site && !business.websiteUrl) {
    try {
      await prisma.business.update({ where: { id: business.id }, data: { auditStatus: 'QUEUED' } })
      await getQueue().enqueue('audit.site', {
        businessId: business.id,
        workspaceId: input.workspaceId,
        depth: 'STANDARD',
        trigger: 'manual',
      })
      result.auditQueued = true
      steps.push({ step: 'Audit', status: 'ok', detail: 'Website audit queued for the newly found site.' })
    } catch (err) {
      steps.push({ step: 'Audit', status: 'failed', detail: (err as Error).message })
    }
  }

  return result
}

async function yelpConfigured(workspaceId: string): Promise<boolean> {
  try {
    const bundle = await getConnectionBundle(workspaceId, 'yelp-fusion')
    return bundle.enabled && Boolean(bundle.secrets.apiKey)
  } catch {
    return false
  }
}
