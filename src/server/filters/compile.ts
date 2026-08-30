import type { Prisma } from '@prisma/client'
import {
  FIELD_MAP,
  isGroup,
  type FieldKind,
  type DateRange,
  type FilterCondition,
  type FilterGroup,
  type LeadQuery,
  type TabId,
} from './schema'

/**
 * Compiles the validated filter DSL into a Prisma `where` (§8, §37).
 *
 * This is the single compiler used by the table, the tab counts and the export.
 * If exports ever disagreed with what the user sees, it would be because
 * something bypassed this function — so nothing does.
 */

export function compileQuery(
  workspaceId: string,
  query: LeadQuery,
): Prisma.BusinessWhereInput {
  const clauses: Prisma.BusinessWhereInput[] = [
    { workspaceId },
    tabWhere(query.tab),
  ]

  const filters = compileGroup(query.filters)
  if (filters) clauses.push(filters)

  if (query.search?.trim()) clauses.push(searchWhere(query.search.trim()))

  if (query.dateRange) {
    const range = compileDateRange(query.dateRange)
    if (range) clauses.push(range)
  }

  return { AND: clauses }
}

/**
 * Tab membership.
 *
 * Note that these are *not* mutually exclusive (§5): a business with
 * needsRedesign, needsSeo and needsSpeed appears in three tabs, by design.
 */
export function tabWhere(tab: TabId): Prisma.BusinessWhereInput {
  switch (tab) {
    case 'website-creation':
      return { needsWebsite: true }
    case 'redesign':
      return { needsRedesign: true }
    case 'seo':
      return { needsSeo: true }
    case 'speed':
      return { needsSpeed: true }
    case 'hot':
      return { leadTier: 'HOT' }
    case 'new':
      // "New" is scoped by the date range the user selected; without one it
      // defaults to the last 7 days rather than silently meaning "everything".
      return {}
    case 'all':
    default:
      return {}
  }
}

function compileGroup(group: FilterGroup): Prisma.BusinessWhereInput | null {
  if (!group?.conditions?.length) return null

  const compiled = group.conditions
    .map((node) => (isGroup(node) ? compileGroup(node) : compileCondition(node)))
    .filter((c): c is Prisma.BusinessWhereInput => c !== null)

  if (compiled.length === 0) return null
  return group.logic === 'OR' ? { OR: compiled } : { AND: compiled }
}

function compileCondition(c: FilterCondition): Prisma.BusinessWhereInput | null {
  const def = FIELD_MAP.get(c.field)
  // Unknown fields were already rejected by zod; this is defence in depth.
  if (!def) return null
  if (!def.operators.includes(c.op)) return null

  if (def.relation) return compileRelation(def.relation, c)
  if (!def.column) return null

  const column = def.column
  const value = coerce(c.value, def.kind)

  switch (c.op) {
    case 'isNull':
      return { [column]: null } as Prisma.BusinessWhereInput
    case 'notNull':
      return { [column]: { not: null } } as Prisma.BusinessWhereInput
    case 'eq':
      if (value === null || value === undefined) return null
      return { [column]: value } as Prisma.BusinessWhereInput
    case 'neq':
      if (value === null || value === undefined) return null
      return { [column]: { not: value } } as Prisma.BusinessWhereInput
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (value === null || value === undefined) return null
      return { [column]: { [c.op]: value } } as Prisma.BusinessWhereInput
    case 'contains':
      if (typeof value !== 'string' || !value) return null
      return {
        [column]: { contains: value, mode: 'insensitive' },
      } as Prisma.BusinessWhereInput
    case 'startsWith':
      if (typeof value !== 'string' || !value) return null
      return {
        [column]: { startsWith: value, mode: 'insensitive' },
      } as Prisma.BusinessWhereInput
    case 'in':
    case 'notIn': {
      const list = Array.isArray(c.value)
        ? c.value.map((v) => coerce(v, def.kind)).filter((v) => v !== null && v !== undefined)
        : []
      if (list.length === 0) return null
      return { [column]: { [c.op]: list } } as Prisma.BusinessWhereInput
    }
    case 'between': {
      if (!Array.isArray(c.value) || c.value.length !== 2) return null
      const [lo, hi] = c.value.map((v) => coerce(v, def.kind))
      if (lo === null || hi === null) return null
      return { [column]: { gte: lo, lte: hi } } as Prisma.BusinessWhereInput
    }
    default:
      return null
  }
}

/**
 * Coerces a JSON value to the type its field expects.
 *
 * Query strings and saved views both arrive as JSON, so "50" must become 50
 * before Prisma sees it — otherwise Postgres raises a type error at runtime
 * instead of the filter simply working.
 */
function coerce(value: unknown, kind: FieldKind): unknown {
  if (value === null || value === undefined) return value

  switch (kind) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : null
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === 1 || value === '1') return true
      if (value === 'false' || value === 0 || value === '0') return false
      return null
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(String(value))
      return Number.isNaN(d.getTime()) ? null : d
    }
    case 'string':
    case 'enum':
    case 'relation':
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

function compileRelation(
  relation: 'source' | 'outreachStage' | 'tag',
  c: FilterCondition,
): Prisma.BusinessWhereInput | null {
  const values = Array.isArray(c.value)
    ? c.value.filter((v): v is string => typeof v === 'string')
    : typeof c.value === 'string'
      ? [c.value]
      : []
  if (values.length === 0) return null

  switch (relation) {
    case 'source':
      return c.op === 'neq'
        ? { sources: { none: { provider: { in: values } } } }
        : { sources: { some: { provider: { in: values } } } }
    case 'outreachStage':
      return c.op === 'neq'
        ? { outreach: { stage: { notIn: values as never[] } } }
        : { outreach: { stage: { in: values as never[] } } }
    case 'tag':
      return { tags: { hasSome: values } }
    default:
      return null
  }
}

/**
 * Full-text-ish search across the fields a salesperson actually types (§39).
 * Every column here is indexed or small; this never becomes a table scan of
 * unindexed text at realistic sizes.
 */
export function searchWhere(term: string): Prisma.BusinessWhereInput {
  const t = term.trim()
  // A digits-heavy term is almost certainly a phone number.
  const digits = t.replace(/\D/g, '')

  const or: Prisma.BusinessWhereInput[] = [
    { name: { contains: t, mode: 'insensitive' } },
    { websiteDomain: { contains: t.toLowerCase() } },
    { primaryEmail: { contains: t.toLowerCase() } },
    { addressLine: { contains: t, mode: 'insensitive' } },
    { city: { contains: t, mode: 'insensitive' } },
  ]

  if (digits.length >= 6) {
    or.push({ primaryPhoneNormalized: { contains: digits } })
    or.push({ contacts: { some: { kind: 'PHONE', normalized: { contains: digits } } } })
  }
  if (t.includes('@')) {
    or.push({ contacts: { some: { kind: 'EMAIL', normalized: { contains: t.toLowerCase() } } } })
  }

  return { OR: or }
}

export function compileDateRange(range: DateRange): Prisma.BusinessWhereInput | null {
  const bounds = resolveDateRange(range)
  if (!bounds) return null
  const condition: Prisma.DateTimeFilter = {}
  if (bounds.from) condition.gte = bounds.from
  if (bounds.to) condition.lte = bounds.to
  if (!condition.gte && !condition.lte) return null
  return { [range.field]: condition } as Prisma.BusinessWhereInput
}

export function resolveDateRange(
  range: DateRange,
): { from: Date | null; to: Date | null } | null {
  const now = new Date()
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
  const endOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)

  switch (range.preset) {
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) }
    case 'yesterday': {
      const y = new Date(now)
      y.setDate(y.getDate() - 1)
      return { from: startOfDay(y), to: endOfDay(y) }
    }
    case 'last7': {
      const f = new Date(now)
      f.setDate(f.getDate() - 6)
      return { from: startOfDay(f), to: endOfDay(now) }
    }
    case 'last30': {
      const f = new Date(now)
      f.setDate(f.getDate() - 29)
      return { from: startOfDay(f), to: endOfDay(now) }
    }
    case 'thisMonth':
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1),
        to: endOfDay(now),
      }
    case 'lastMonth':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
      }
    case 'custom': {
      const from = range.from ? new Date(range.from) : null
      const to = range.to ? new Date(range.to) : null
      if (!from && !to) return null
      return { from, to }
    }
    case 'all':
    default:
      return null
  }
}

export function compileOrderBy(
  sort: LeadQuery['sort'],
): Prisma.BusinessOrderByWithRelationInput[] {
  // Nulls last on every score column: an unaudited business must never sit at
  // the top of "worst SEO first".
  const direction = sort.direction
  const primary = {
    [sort.field]: { sort: direction, nulls: 'last' },
  } as unknown as Prisma.BusinessOrderByWithRelationInput

  // A stable secondary key keeps pagination deterministic across pages.
  return [primary, { id: 'asc' }]
}
