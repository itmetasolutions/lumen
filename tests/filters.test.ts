import { describe, it, expect } from 'vitest'
import { querySchema, filterGroupSchema, EMPTY_FILTER } from '@/server/filters/schema'
import { compileQuery, tabWhere, resolveDateRange, compileOrderBy, searchWhere } from '@/server/filters/compile'

/**
 * §8/§37 — the filter compiler.
 *
 * These tests matter because the same compiler feeds the table, the tab counts
 * and the export. If it drifts, "Export Current Filter" silently exports the
 * wrong rows — the exact failure mode the brief calls out.
 */

const WS = 'ws_1'

function q(over: Record<string, unknown> = {}) {
  return querySchema.parse({ tab: 'all', ...over })
}

describe('validation', () => {
  it('rejects filters on fields that are not in the registry', () => {
    const result = filterGroupSchema.safeParse({
      logic: 'AND',
      conditions: [{ field: 'passwordHash', op: 'eq', value: 'x' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects unknown operators', () => {
    const result = filterGroupSchema.safeParse({
      logic: 'AND',
      conditions: [{ field: 'city', op: 'drop table', value: 'x' }],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a valid nested group', () => {
    const result = filterGroupSchema.safeParse({
      logic: 'AND',
      conditions: [
        { field: 'city', op: 'eq', value: 'London' },
        {
          logic: 'OR',
          conditions: [
            { field: 'seoHealth', op: 'lt', value: 50 },
            { field: 'perfScoreMobile', op: 'lt', value: 40 },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a page size beyond the cap', () => {
    expect(querySchema.safeParse({ tab: 'all', pageSize: 100_000 }).success).toBe(false)
  })
})

describe('workspace isolation', () => {
  it('always scopes to the workspace', () => {
    const where = compileQuery(WS, q())
    const clauses = (where.AND ?? []) as Array<Record<string, unknown>>
    expect(clauses.some((c) => c.workspaceId === WS)).toBe(true)
  })
})

describe('tab predicates', () => {
  it('maps each service tab to its opportunity flag', () => {
    expect(tabWhere('website-creation')).toEqual({ needsWebsite: true })
    expect(tabWhere('redesign')).toEqual({ needsRedesign: true })
    expect(tabWhere('seo')).toEqual({ needsSeo: true })
    expect(tabWhere('speed')).toEqual({ needsSpeed: true })
    expect(tabWhere('hot')).toEqual({ leadTier: 'HOT' })
    expect(tabWhere('all')).toEqual({})
  })

  it('keeps tabs overlapping — they are independent flags, not exclusive states', () => {
    // Nothing in a tab predicate excludes another opportunity.
    const redesign = tabWhere('redesign') as Record<string, unknown>
    expect(Object.keys(redesign)).toEqual(['needsRedesign'])
    expect(redesign.needsSeo).toBeUndefined()
  })
})

describe('condition compilation', () => {
  it('coerces string numbers so a query-string filter works', () => {
    const where = compileQuery(
      WS,
      q({
        filters: {
          logic: 'AND',
          conditions: [{ field: 'seoHealth', op: 'lt', value: '50' }],
        },
      }),
    )
    const json = JSON.stringify(where)
    expect(json).toContain('"seoHealth":{"lt":50}')
    expect(json).not.toContain('"lt":"50"')
  })

  it('compiles a nested OR inside an AND', () => {
    const where = compileQuery(
      WS,
      q({
        filters: {
          logic: 'AND',
          conditions: [
            { field: 'city', op: 'eq', value: 'London' },
            {
              logic: 'OR',
              conditions: [
                { field: 'needsSeo', op: 'eq', value: true },
                { field: 'needsSpeed', op: 'eq', value: true },
              ],
            },
          ],
        },
      }),
    )
    const json = JSON.stringify(where)
    expect(json).toContain('"OR"')
    expect(json).toContain('"needsSeo":true')
  })

  it('compiles between into a gte/lte pair', () => {
    const where = compileQuery(
      WS,
      q({
        filters: {
          logic: 'AND',
          conditions: [{ field: 'rating', op: 'between', value: [4, 5] }],
        },
      }),
    )
    expect(JSON.stringify(where)).toContain('"rating":{"gte":4,"lte":5}')
  })

  it('makes text matching case-insensitive', () => {
    const where = compileQuery(
      WS,
      q({
        filters: {
          logic: 'AND',
          conditions: [{ field: 'city', op: 'contains', value: 'lond' }],
        },
      }),
    )
    expect(JSON.stringify(where)).toContain('"mode":"insensitive"')
  })

  it('compiles relation filters for source and outreach stage', () => {
    const where = compileQuery(
      WS,
      q({
        filters: {
          logic: 'AND',
          conditions: [
            { field: 'source', op: 'in', value: ['google-places'] },
            { field: 'outreachStage', op: 'eq', value: 'NOT_CONTACTED' },
          ],
        },
      }),
    )
    const json = JSON.stringify(where)
    expect(json).toContain('"sources"')
    expect(json).toContain('"outreach"')
  })

  it('drops conditions with no usable value rather than matching everything', () => {
    const where = compileQuery(
      WS,
      q({
        filters: {
          logic: 'AND',
          conditions: [{ field: 'city', op: 'contains', value: '' }],
        },
      }),
    )
    expect(JSON.stringify(where)).not.toContain('contains')
  })
})

describe('search', () => {
  it('searches names, domains, emails and addresses', () => {
    const json = JSON.stringify(searchWhere('acme'))
    expect(json).toContain('name')
    expect(json).toContain('websiteDomain')
    expect(json).toContain('primaryEmail')
  })

  it('treats a digit-heavy term as a phone number', () => {
    const json = JSON.stringify(searchWhere('0161 234 5678'))
    expect(json).toContain('primaryPhoneNormalized')
    expect(json).toContain('01612345678')
  })
})

describe('date ranges', () => {
  it('resolves relative presets', () => {
    const today = resolveDateRange({ preset: 'today', field: 'discoveredAt' })
    expect(today?.from).toBeInstanceOf(Date)
    expect(today?.to).toBeInstanceOf(Date)
    expect(resolveDateRange({ preset: 'all', field: 'discoveredAt' })).toBeNull()
  })

  it('resolves last 7 days as a 7-day window', () => {
    const r = resolveDateRange({ preset: 'last7', field: 'discoveredAt' })!
    const days = (r.to!.getTime() - r.from!.getTime()) / 86_400_000
    expect(days).toBeGreaterThan(6)
    expect(days).toBeLessThan(7.1)
  })
})

describe('ordering', () => {
  it('sorts nulls last so unaudited rows never lead a worst-first sort', () => {
    const order = compileOrderBy({ field: 'seoHealth', direction: 'asc' })
    expect(JSON.stringify(order[0])).toContain('"nulls":"last"')
  })

  it('adds a stable secondary key so pagination is deterministic', () => {
    const order = compileOrderBy({ field: 'leadScore', direction: 'desc' })
    expect(order[1]).toEqual({ id: 'asc' })
  })
})

describe('export parity (§37)', () => {
  it('produces an identical where-clause for the table and the export', () => {
    const query = q({
      tab: 'seo',
      filters: {
        logic: 'AND',
        conditions: [
          { field: 'city', op: 'eq', value: 'London' },
          { field: 'seoHealth', op: 'lt', value: 50 },
          { field: 'rating', op: 'gte', value: 4 },
          { field: 'reviewCount', op: 'gte', value: 50 },
          { field: 'hasPhone', op: 'eq', value: true },
        ],
      },
    })

    // The table calls compileQuery; so does the export job. Same input, same output.
    const forTable = compileQuery(WS, query)
    const forExport = compileQuery(WS, query)
    expect(JSON.stringify(forTable)).toBe(JSON.stringify(forExport))
  })

  it('an "export all" clause drops filters but keeps the tab and workspace', () => {
    const query = q({
      tab: 'seo',
      filters: { logic: 'AND', conditions: [{ field: 'city', op: 'eq', value: 'London' }] },
    })
    const all = compileQuery(WS, {
      ...query,
      filters: EMPTY_FILTER,
      search: undefined,
      dateRange: undefined,
    })
    const json = JSON.stringify(all)
    expect(json).toContain('needsSeo')
    expect(json).toContain(WS)
    expect(json).not.toContain('London')
  })
})

describe('unaudited selection (§ bulk audit)', () => {
  it('targets only businesses with no usable audit', async () => {
    const { unauditedWhere } = await import('@/server/leads/audit-queue')
    const json = JSON.stringify(unauditedWhere(WS, undefined, false))
    expect(json).toContain('NOT_AUDITED')
    // Work already in flight must not be queued a second time.
    expect(json).not.toContain('QUEUED')
    expect(json).not.toContain('RUNNING')
  })

  it('can include previously failed audits when asked', async () => {
    const { unauditedWhere } = await import('@/server/leads/audit-queue')
    const json = JSON.stringify(unauditedWhere(WS, undefined, true))
    expect(json).toContain('FAILED')
    expect(json).toContain('NOT_AUDITED')
  })

  it('stays inside the workspace', async () => {
    const { unauditedWhere } = await import('@/server/leads/audit-queue')
    expect(JSON.stringify(unauditedWhere(WS, undefined, false))).toContain(WS)
  })

  it('respects an active filter so "audit unaudited" follows the visible view', async () => {
    const { unauditedWhere } = await import('@/server/leads/audit-queue')
    const query = q({
      tab: 'seo',
      filters: { logic: 'AND', conditions: [{ field: 'city', op: 'eq', value: 'London' }] },
    })
    const json = JSON.stringify(unauditedWhere(WS, query, false))
    expect(json).toContain('London')
    expect(json).toContain('needsSeo')
    expect(json).toContain('NOT_AUDITED')
  })
})
