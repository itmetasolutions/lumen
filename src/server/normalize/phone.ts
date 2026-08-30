/**
 * Phone normalisation to an E.164-shaped key used for entity resolution (§3).
 *
 * Deliberately conservative: when the country cannot be established we keep the
 * digits and mark `confident: false` rather than inventing a country code. A
 * wrong country code would silently merge two unrelated businesses.
 */

export interface NormalizedPhone {
  /** E.164 when derivable ("+441612345678"), otherwise a digits-only key. */
  normalized: string
  /** Human-facing form, preserved from input when it was already sensible. */
  display: string
  countryCode: string | null
  confident: boolean
}

/** ISO-3166 alpha-2 → { calling code, national trunk prefix, national digit lengths } */
const COUNTRY_DIALING: Record<
  string,
  { cc: string; trunk?: string; nsn: number[] }
> = {
  US: { cc: '1', trunk: '1', nsn: [10] },
  CA: { cc: '1', trunk: '1', nsn: [10] },
  GB: { cc: '44', trunk: '0', nsn: [9, 10] },
  IE: { cc: '353', trunk: '0', nsn: [7, 8, 9] },
  AU: { cc: '61', trunk: '0', nsn: [9] },
  NZ: { cc: '64', trunk: '0', nsn: [8, 9] },
  DE: { cc: '49', trunk: '0', nsn: [6, 7, 8, 9, 10, 11] },
  FR: { cc: '33', trunk: '0', nsn: [9] },
  ES: { cc: '34', nsn: [9] },
  IT: { cc: '39', nsn: [9, 10] },
  NL: { cc: '31', trunk: '0', nsn: [9] },
  BE: { cc: '32', trunk: '0', nsn: [8, 9] },
  PT: { cc: '351', nsn: [9] },
  SE: { cc: '46', trunk: '0', nsn: [7, 8, 9] },
  NO: { cc: '47', nsn: [8] },
  DK: { cc: '45', nsn: [8] },
  FI: { cc: '358', trunk: '0', nsn: [6, 7, 8, 9] },
  PL: { cc: '48', nsn: [9] },
  CH: { cc: '41', trunk: '0', nsn: [9] },
  AT: { cc: '43', trunk: '0', nsn: [7, 8, 9, 10] },
  IN: { cc: '91', trunk: '0', nsn: [10] },
  PK: { cc: '92', trunk: '0', nsn: [10] },
  AE: { cc: '971', trunk: '0', nsn: [8, 9] },
  SA: { cc: '966', trunk: '0', nsn: [9] },
  ZA: { cc: '27', trunk: '0', nsn: [9] },
  SG: { cc: '65', nsn: [8] },
  MY: { cc: '60', trunk: '0', nsn: [8, 9, 10] },
  JP: { cc: '81', trunk: '0', nsn: [9, 10] },
  BR: { cc: '55', trunk: '0', nsn: [10, 11] },
  MX: { cc: '52', trunk: '01', nsn: [10] },
}

/** Longest-match set of calling codes, used when the input already has a "+". */
const CALLING_CODES = Array.from(
  new Set(Object.values(COUNTRY_DIALING).map((c) => c.cc)),
).sort((a, b) => b.length - a.length)

function digitsOnly(input: string): string {
  return input.replace(/\D+/g, '')
}

export function normalizePhone(
  raw: string | null | undefined,
  countryCode?: string | null,
): NormalizedPhone | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Reject obvious non-numbers early (e.g. "Not Found", "call us").
  const digits = digitsOnly(trimmed)
  if (digits.length < 6 || digits.length > 15) return null

  const hasPlus = trimmed.trimStart().startsWith('+')
  const isInternational = hasPlus || /^00\d/.test(digits) || digits.startsWith('00')

  // Case 1 — already international.
  if (hasPlus || /^00/.test(trimmed.replace(/[^\d+]/g, ''))) {
    const body = hasPlus ? digits : digits.replace(/^00/, '')
    const cc = CALLING_CODES.find((c) => body.startsWith(c))
    return {
      normalized: `+${body}`,
      display: `+${body}`,
      countryCode: cc ? countryForCallingCode(cc) : null,
      confident: true,
    }
  }

  // Case 2 — national format with a known country context.
  const cfg = countryCode ? COUNTRY_DIALING[countryCode.toUpperCase()] : undefined
  if (cfg) {
    let nsn = digits
    if (cfg.trunk && nsn.startsWith(cfg.trunk) && nsn.length > cfg.trunk.length) {
      nsn = nsn.slice(cfg.trunk.length)
    }
    if (cfg.nsn.includes(nsn.length)) {
      return {
        normalized: `+${cfg.cc}${nsn}`,
        display: trimmed,
        countryCode: countryCode!.toUpperCase(),
        confident: true,
      }
    }
  }

  // Case 3 — unknown country. Keep the digits as the key; do NOT invent a prefix.
  return {
    normalized: digits,
    display: trimmed,
    countryCode: null,
    confident: false,
  }
}

function countryForCallingCode(cc: string): string | null {
  const entry = Object.entries(COUNTRY_DIALING).find(([, v]) => v.cc === cc)
  return entry ? entry[0] : null
}

/**
 * Two phone keys match if their significant digits agree.
 *
 * The leading national trunk prefix must be stripped before comparing, because
 * the same line is written "+44 161 234 5678" by one provider and "0161 234
 * 5678" by another — the "0" is a national dialling artefact, not part of the
 * number. A minimum of 7 significant digits avoids matching on an extension.
 */
export function phonesMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true

  const significant = (v: string) => v.replace(/\D/g, '').replace(/^0+/, '')
  const da = significant(a)
  const db = significant(b)
  if (!da || !db) return false
  if (da === db) return true

  const [long, short] = da.length >= db.length ? [da, db] : [db, da]
  return short.length >= 7 && long.endsWith(short)
}
