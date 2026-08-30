import 'server-only'

/**
 * File parsing for lead imports.
 *
 * CSV is parsed here rather than with a dependency because the format Lumen
 * exports is well defined and the tricky parts — quoted fields containing
 * commas, embedded newlines, escaped quotes, a UTF-8 BOM — are a few dozen lines
 * of code that are easier to reason about than a library's edge cases.
 */

export type ParsedRow = Record<string, string>

export interface ParsedFile {
  headers: string[]
  rows: ParsedRow[]
}

/** RFC 4180 with the usual real-world tolerances. */
export function parseCsv(input: string): ParsedFile {
  // Excel writes a BOM; leaving it turns the first header into "﻿Business Name".
  const text = input.replace(/^﻿/, '')

  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\r') {
      // Swallow; the \n that follows ends the record.
    } else if (char === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else {
      field += char
    }
  }

  // A final line with no trailing newline still counts.
  if (field.length > 0 || record.length > 0) {
    record.push(field)
    records.push(record)
  }

  return toParsedFile(records)
}

export async function parseXlsx(buffer: Buffer): Promise<ParsedFile> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)

  const sheet = workbook.worksheets[0]
  if (!sheet) return { headers: [], rows: [] }

  const records: string[][] = []
  sheet.eachRow((row) => {
    const values: string[] = []
    // exceljs rows are 1-indexed and `values[0]` is always empty.
    const raw = row.values as unknown[]
    for (let i = 1; i < raw.length; i++) {
      values.push(cellToString(raw[i]))
    }
    records.push(values)
  })

  return toParsedFile(records)
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // Hyperlink and rich-text cells carry their display text in these shapes.
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.result === 'string' || typeof obj.result === 'number') return String(obj.result)
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((r) => String((r as { text?: string }).text ?? '')).join('')
    }
    if (typeof obj.hyperlink === 'string') return obj.hyperlink
  }
  return String(value)
}

function toParsedFile(records: string[][]): ParsedFile {
  // Skip leading blank lines rather than treating one as the header row.
  const first = records.findIndex((r) => r.some((c) => c.trim() !== ''))
  if (first < 0) return { headers: [], rows: [] }

  const headers = records[first]!.map((h) => h.trim())
  const rows: ParsedRow[] = []

  for (let i = first + 1; i < records.length; i++) {
    const record = records[i]!
    if (record.every((c) => c.trim() === '')) continue

    const row: ParsedRow = {}
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c]
      if (!key) continue
      row[key] = (record[c] ?? '').trim()
    }
    rows.push(row)
  }

  return { headers, rows }
}
