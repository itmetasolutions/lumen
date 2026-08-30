/** Address normalisation used as a dedupe signal (§3). */

const STREET_ABBREV: Record<string, string> = {
  street: 'st', str: 'st', st: 'st',
  road: 'rd', rd: 'rd',
  avenue: 'ave', av: 'ave', ave: 'ave',
  boulevard: 'blvd', blvd: 'blvd',
  drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  place: 'pl', pl: 'pl',
  square: 'sq', sq: 'sq',
  terrace: 'ter', ter: 'ter',
  parade: 'pde', pde: 'pde',
  crescent: 'cres', cres: 'cres',
  close: 'cl', cl: 'cl',
  suite: 'ste', ste: 'ste',
  unit: 'unit',
  floor: 'fl', fl: 'fl',
  north: 'n', south: 's', east: 'e', west: 'w',
}

export function normalizeAddress(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  s = s
    .split(' ')
    .map((t) => STREET_ABBREV[t] ?? t)
    .join(' ')

  return s
}

export function normalizePostalCode(
  raw: string | null | undefined,
  countryCode?: string | null,
): string | null {
  if (!raw) return null
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!s) return null
  // UK postcodes are compared without the space; US ZIP+4 collapses to the ZIP5
  // because providers disagree on whether they include the +4.
  if (countryCode === 'US' && s.length === 9) return s.slice(0, 5)
  return s
}

/** Leading house/building number — a strong disambiguator on the same street. */
export function houseNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d+[a-zA-Z]?)/)
  return m ? m[1]!.toLowerCase() : null
}

export function addressSimilarity(a: string | null, b: string | null): number {
  const na = normalizeAddress(a)
  const nb = normalizeAddress(b)
  if (!na || !nb) return 0
  if (na === nb) return 1

  const ta = new Set(na.split(' ').filter(Boolean))
  const tb = new Set(nb.split(' ').filter(Boolean))
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}
