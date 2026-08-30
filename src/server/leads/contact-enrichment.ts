import 'server-only'
import * as cheerio from 'cheerio'
import { prisma } from '@/server/db/client'
import { crawlSite, type CrawlResult } from '@/server/crawler/crawl'
import { normalizeEmail } from '@/server/discovery/normalize'
import { compileQuery } from '@/server/filters/compile'
import { normalizePhone } from '@/server/normalize/phone'
import { normalizeUrl, resolveUrl, socialNetworkOf } from '@/server/normalize/url'
import type { Prisma } from '@prisma/client'
import type { LeadQuery } from '@/server/filters/schema'

const ENRICH_PROVIDER = 'website-crawl'
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 50

/**
 * Wall-clock budget for one call.
 *
 * Enrichment crawls one site at a time, and a slow site can take tens of
 * seconds. Bounding the *call* rather than only the row count is what keeps this
 * inside the HTTP timeout: the caller gets whatever completed plus `remaining`,
 * and repeats until `remaining` is zero. Without this, a batch of 25 could sit
 * in a single request for ~19 minutes and be killed with nothing reported.
 */
const DEFAULT_DEADLINE_MS = 40_000
const PER_SITE_BUDGET_MS = 20_000
const PER_SITE_MAX_PAGES = 3

export interface EnrichmentContact {
  kind: 'PHONE' | 'EMAIL' | 'SOCIAL'
  value: string
  normalized: string
  label: string | null
  sourceUrl: string
  confidence: number
}

export interface EnrichmentResult {
  processed: number
  updated: number
  skippedNoWebsite: number
  contactsAdded: number
  phonesAdded: number
  emailsAdded: number
  socialsAdded: number
  errors: Array<{ businessId: string; name: string; error: string }>
  /** Businesses still matching the criteria after this call — drives the resume loop. */
  remaining: number
  /** True when the call returned because it ran out of time, not out of work. */
  stoppedEarly: boolean
}

export function noContactWhere(workspaceId: string): Prisma.BusinessWhereInput {
  return {
    workspaceId,
    hasPhone: false,
    hasEmail: false,
    hasWebsite: false,
    hasSocial: false,
  }
}

export async function deleteNoContactLeads(workspaceId: string): Promise<number> {
  const result = await prisma.business.deleteMany({
    where: noContactWhere(workspaceId),
  })
  return result.count
}

export async function enrichMissingContacts(input: {
  workspaceId: string
  ids?: string[]
  query?: LeadQuery
  limit?: number
  deadlineMs?: number
}): Promise<EnrichmentResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT))
  const deadline = Date.now() + Math.max(5_000, input.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const where = enrichmentWhere(input.workspaceId, input.ids, input.query)

  const rows = await prisma.business.findMany({
    where,
    select: {
      id: true,
      name: true,
      websiteUrl: true,
      countryCode: true,
      primaryPhone: true,
      primaryEmail: true,
      hasPhone: true,
      hasEmail: true,
      hasSocial: true,
    },
    orderBy: { lastSeenAt: 'desc' },
    take: limit,
  })

  const result: EnrichmentResult = {
    processed: 0,
    updated: 0,
    skippedNoWebsite: 0,
    contactsAdded: 0,
    phonesAdded: 0,
    emailsAdded: 0,
    socialsAdded: 0,
    errors: [],
    remaining: 0,
    stoppedEarly: false,
  }

  for (const business of rows) {
    // Stop cleanly on the deadline rather than being killed mid-crawl by the
    // request timeout. Whatever completed is already committed and reported.
    if (Date.now() >= deadline) {
      result.stoppedEarly = true
      break
    }

    if (!business.websiteUrl) {
      result.skippedNoWebsite++
      continue
    }

    result.processed++
    try {
      const crawl = await crawlSite(business.websiteUrl, {
        maxPages: PER_SITE_MAX_PAGES,
        timeoutMsPerPage: 10_000,
        // Never let one slow site consume the whole call budget.
        totalBudgetMs: Math.min(PER_SITE_BUDGET_MS, Math.max(5_000, deadline - Date.now())),
        delayMs: 400,
      })
      const contacts = extractContactsFromCrawl(crawl, business.countryCode).filter((contact) => {
        if (contact.kind === 'PHONE') return !business.hasPhone
        if (contact.kind === 'EMAIL') return !business.hasEmail
        return !business.hasSocial
      })
      if (contacts.length === 0) {
        await prisma.business.update({
          where: { id: business.id },
          data: { lastCrawledAt: new Date(), contactsEnrichedAt: new Date() },
        })
        continue
      }

      const create = await prisma.businessContact.createMany({
        data: contacts.map((contact) => ({
          businessId: business.id,
          kind: contact.kind,
          value: contact.value,
          normalized: contact.normalized,
          label: contact.label,
          provider: ENRICH_PROVIDER,
          sourceUrl: contact.sourceUrl,
          confidence: contact.confidence,
          verifiedAt: new Date(),
        })),
        skipDuplicates: true,
      })

      const phone = !business.primaryPhone
        ? contacts.find((contact) => contact.kind === 'PHONE')
        : undefined
      const email = !business.primaryEmail
        ? contacts.find((contact) => contact.kind === 'EMAIL')
        : undefined

      await prisma.business.update({
        where: { id: business.id },
        data: {
          hasPhone: business.hasPhone || contacts.some((contact) => contact.kind === 'PHONE'),
          hasEmail: business.hasEmail || contacts.some((contact) => contact.kind === 'EMAIL'),
          hasSocial: business.hasSocial || contacts.some((contact) => contact.kind === 'SOCIAL'),
          primaryPhone: phone?.value,
          primaryPhoneNormalized: phone?.normalized,
          primaryEmail: email?.value,
          lastCrawledAt: new Date(),
          lastSeenAt: new Date(),
          contactsEnrichedAt: new Date(),
        },
      })

      if (create.count > 0) {
        result.updated++
        result.contactsAdded += create.count
        result.phonesAdded += contacts.filter((contact) => contact.kind === 'PHONE').length
        result.emailsAdded += contacts.filter((contact) => contact.kind === 'EMAIL').length
        result.socialsAdded += contacts.filter((contact) => contact.kind === 'SOCIAL').length
      }
    } catch (err) {
      result.errors.push({
        businessId: business.id,
        name: business.name,
        error: (err as Error).message,
      })
      // Mark the attempt so one unreachable site cannot stall every later pass.
      await prisma.business
        .update({ where: { id: business.id }, data: { contactsEnrichedAt: new Date() } })
        .catch(() => {})
    }
  }

  // Counted after the writes above, so a business enriched in this pass is no
  // longer "remaining" — the UI can loop until this reaches zero.
  result.remaining = await prisma.business.count({
    where: enrichmentWhere(input.workspaceId, input.ids, input.query, true),
  })

  return result
}

/** How long an enrichment attempt is considered current for bulk runs. */
const RETRY_AFTER_DAYS = 7

function enrichmentWhere(
  workspaceId: string,
  ids: string[] | undefined,
  query: LeadQuery | undefined,
  /**
   * Force the freshness filter on. Used when counting what is left to do: rows
   * attempted by the call that just ran must not be counted as outstanding, or
   * a caller looping on `remaining` would never terminate.
   */
  forRemaining = false,
): Prisma.BusinessWhereInput {
  const explicit = Boolean(ids?.length) && !forRemaining

  const base: Prisma.BusinessWhereInput = ids?.length
    ? { workspaceId, id: { in: ids } }
    : query
      ? compileQuery(workspaceId, query)
      : { workspaceId }

  const clauses: Prisma.BusinessWhereInput[] = [
    base,
    { hasWebsite: true, websiteUrl: { not: null } },
    { OR: [{ hasPhone: false }, { hasEmail: false }, { hasSocial: false }] },
  ]

  // Picking specific rows is an explicit instruction, so honour it even if they
  // were enriched a minute ago. A bulk run instead skips anything already
  // attempted recently — otherwise sites that publish no contact details would
  // be re-crawled on every pass and the run would never finish.
  if (!explicit) {
    clauses.push({
      OR: [
        { contactsEnrichedAt: null },
        {
          contactsEnrichedAt: {
            lt: new Date(Date.now() - RETRY_AFTER_DAYS * 86_400_000),
          },
        },
      ],
    })
  }

  return { AND: clauses }
}

export function extractContactsFromCrawl(
  crawl: CrawlResult,
  countryCode?: string | null,
): EnrichmentContact[] {
  const contacts = new Map<string, EnrichmentContact>()

  for (const page of crawl.pages) {
    if (!page.html || page.error) continue
    const $ = cheerio.load(page.html)

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') ?? '').trim()
      if (!href) return

      if (/^mailto:/i.test(href)) {
        addEmail(contacts, cleanMailto(href), page.finalUrl, 76)
        return
      }

      if (/^tel:/i.test(href)) {
        addPhone(contacts, cleanTel(href), countryCode, page.finalUrl, 76)
        return
      }

      const absolute = resolveUrl(page.finalUrl, href)
      if (absolute) addSocial(contacts, absolute, page.finalUrl)
    })

    const text = $('body').text().replace(/\s+/g, ' ')
    for (const match of text.matchAll(EMAIL_RE)) {
      addEmail(contacts, match[0], page.finalUrl, 66)
    }
    for (const match of text.matchAll(PHONE_RE)) {
      const raw = match[0]
      const index = match.index ?? 0
      const context = text.slice(Math.max(0, index - 50), index + raw.length + 30)
      if (!/\b(phone|call|tel|mobile|office|contact|enquiries|appointments?)\b/i.test(context)) {
        continue
      }
      addPhone(contacts, raw, countryCode, page.finalUrl, 62)
    }
  }

  return Array.from(contacts.values())
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g

function addEmail(
  contacts: Map<string, EnrichmentContact>,
  raw: string | null,
  sourceUrl: string,
  confidence: number,
): void {
  const normalized = normalizeEmail(raw)
  if (!normalized) return
  const key = `EMAIL:${normalized}`
  if (contacts.has(key)) return
  contacts.set(key, {
    kind: 'EMAIL',
    value: normalized,
    normalized,
    label: null,
    sourceUrl,
    confidence,
  })
}

function addPhone(
  contacts: Map<string, EnrichmentContact>,
  raw: string | null,
  countryCode: string | null | undefined,
  sourceUrl: string,
  confidence: number,
): void {
  const phone = normalizePhone(raw, countryCode)
  if (!phone) return
  const key = `PHONE:${phone.normalized}`
  if (contacts.has(key)) return
  contacts.set(key, {
    kind: 'PHONE',
    value: phone.display,
    normalized: phone.normalized,
    label: 'website',
    sourceUrl,
    confidence: phone.confident ? confidence : Math.max(35, confidence - 20),
  })
}

function addSocial(
  contacts: Map<string, EnrichmentContact>,
  rawUrl: string,
  sourceUrl: string,
): void {
  const normalized = normalizeUrl(rawUrl)
  if (!normalized) return
  const label = socialNetworkOf(normalized.href)
  if (!label) return
  if (/(\/share|\/sharer|\/intent\/|\/dialog\/)/i.test(normalized.path)) return
  const key = `SOCIAL:${normalized.href}`
  if (contacts.has(key)) return
  contacts.set(key, {
    kind: 'SOCIAL',
    value: normalized.href,
    normalized: normalized.href,
    label,
    sourceUrl,
    confidence: 70,
  })
}

function cleanMailto(raw: string): string | null {
  const value = raw.replace(/^mailto:/i, '').split('?')[0]?.trim()
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function cleanTel(raw: string): string | null {
  const value = raw.replace(/^tel:/i, '').split('?')[0]?.trim()
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
