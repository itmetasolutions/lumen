import { describe, it, expect } from 'vitest'
import { parseCsv } from '@/server/import/parse'
import { mapHeaders, mapRow } from '@/server/import/map-rows'

/**
 * Lead import.
 *
 * The round-trip properties matter most: a file this app exported must import
 * back without corruption, and audit results must not travel between workspaces.
 */

function mapped(csv: string) {
  const parsed = parseCsv(csv)
  const mapping = mapHeaders(parsed.headers)
  return { parsed, mapping, rows: parsed.rows.map((r) => mapRow(r, mapping)) }
}

describe('CSV parsing', () => {
  it('handles quoted fields containing commas and newlines', () => {
    const { parsed } = mapped(
      'Business Name,Address\n"Acme, Ltd","12 High Street\nManchester"\n',
    )
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]!['Business Name']).toBe('Acme, Ltd')
    expect(parsed.rows[0]!.Address).toContain('Manchester')
  })

  it('handles escaped quotes', () => {
    const { parsed } = mapped('Business Name\n"The ""Best"" Cafe"\n')
    expect(parsed.rows[0]!['Business Name']).toBe('The "Best" Cafe')
  })

  it('strips the UTF-8 BOM Excel writes', () => {
    const { parsed } = mapped('﻿Business Name\nAcme\n')
    expect(parsed.headers[0]).toBe('Business Name')
    expect(parsed.rows[0]!['Business Name']).toBe('Acme')
  })

  it('tolerates CRLF and a missing trailing newline', () => {
    const { parsed } = mapped('Business Name,City\r\nAcme,Manchester')
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]!.City).toBe('Manchester')
  })

  it('skips blank lines rather than importing empty rows', () => {
    const { parsed } = mapped('Business Name\nAcme\n\n\nBeta\n')
    expect(parsed.rows).toHaveLength(2)
  })
})

describe('header mapping', () => {
  it('recognises the exporter\'s own column labels', () => {
    const { mapping } = mapped('Business Name,Phone,Email,Website,City\nAcme,1,a@b.com,x.com,M\n')
    expect(mapping.resolved.name).toBe('Business Name')
    expect(mapping.resolved.primaryPhone).toBe('Phone')
    expect(mapping.resolved.primaryEmail).toBe('Email')
    expect(mapping.missingRequired).toEqual([])
  })

  it('accepts common alternative headings', () => {
    const { mapping } = mapped('Company Name,Telephone,Postcode\nAcme,1,M20\n')
    expect(mapping.resolved.name).toBe('Company Name')
    expect(mapping.resolved.primaryPhone).toBe('Telephone')
    expect(mapping.resolved.postalCode).toBe('Postcode')
  })

  it('reports a file with no name column instead of importing nothing', () => {
    const { mapping } = mapped('Phone,City\n123,Manchester\n')
    expect(mapping.missingRequired).toContain('Business Name')
  })

  it('explains why audit columns are ignored', () => {
    const { mapping } = mapped('Business Name,Lead Score,SEO Health\nAcme,91,28\n')
    const ignored = mapping.ignored.map((i) => i.header)
    expect(ignored).toContain('Lead Score')
    expect(ignored).toContain('SEO Health')
    expect(mapping.ignored.find((i) => i.header === 'Lead Score')?.reason).toMatch(/Audit result/)
  })
})

describe('round-trip fidelity', () => {
  it('strips the spreadsheet formula guard the exporter adds', () => {
    // The CSV writer prefixes values starting with = + - @ so Excel cannot
    // execute them. Every phone number starts with "+".
    const { rows } = mapped("Business Name,Phone\nAcme,'+441612345678\n")
    expect((rows[0]!.business.phones ?? [])[0]).toBe('+441612345678')
  })

  it('leaves a value that genuinely starts with an apostrophe alone', () => {
    const { rows } = mapped("Business Name\n'Tis The Season Cafe\n")
    expect(rows[0]!.business.name).toBe("'Tis The Season Cafe")
  })

  it('treats "Not Found" as absent rather than as data', () => {
    const { rows } = mapped('Business Name,Phone,Email,City\nAcme,Not Found,Not Found,Manchester\n')
    const b = rows[0]!.business
    expect(b.phones).toEqual([])
    expect(b.emails).toEqual([])
    expect(b.city).toBe('Manchester')
  })

  it('never carries audit scores across', () => {
    const { rows } = mapped(
      'Business Name,Lead Score,SEO Health,Performance (Mobile)\nAcme,91,28,34\n',
    )
    const b = rows[0]!.business as unknown as Record<string, unknown>
    expect(b.leadScore).toBeUndefined()
    expect(b.seoHealth).toBeUndefined()
  })

  it('imports ratings and review counts as facts, ignoring junk', () => {
    const { rows } = mapped('Business Name,Rating,Reviews\nAcme,4.6,"1,234"\n')
    expect(rows[0]!.business.rating).toBe(4.6)
    expect(rows[0]!.business.reviewCount).toBe(1234)
  })

  it('discards an out-of-range rating rather than storing it', () => {
    const { rows } = mapped('Business Name,Rating\nAcme,97\n')
    expect(rows[0]!.business.rating).toBeNull()
  })

  it('splits multi-value columns', () => {
    const { rows } = mapped(
      'Business Name,Additional Phones,Social Profiles\nAcme,"0161 111 2222, 0161 333 4444","https://facebook.com/a, https://instagram.com/a"\n',
    )
    expect((rows[0]!.business.phones ?? []).length).toBe(2)
    expect((rows[0]!.business.socials ?? []).length).toBe(2)
  })

  it('preserves the DEMO DATA marker so demo rows cannot become live', () => {
    const demo = mapped('Business Name,Data Type\nAcme,DEMO DATA\n')
    const live = mapped('Business Name,Data Type\nAcme,Live\n')
    expect(demo.rows[0]!.isDemo).toBe(true)
    expect(live.rows[0]!.isDemo).toBe(false)
  })

  it('marks imported rows as lower confidence than a live provider', () => {
    const { rows } = mapped('Business Name\nAcme\n')
    // Google Places is 90, OSM 72 — an imported row must not outrank them.
    expect(rows[0]!.business.confidence).toBeLessThan(72)
  })

  it('skips a row with no business name', () => {
    const { rows } = mapped('Business Name,City\n,Manchester\nAcme,Manchester\n')
    expect(rows[0]).toBeNull()
    expect(rows[1]?.business.name).toBe('Acme')
  })
})
