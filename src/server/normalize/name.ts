/**
 * Business-name normalisation for entity resolution (§3).
 *
 * Goal: "ABC Dental Ltd." , "ABC Dental Limited" and "abc dental" collapse to the
 * same blocking key, while "ABC Dental" and "ABCD Dental" do not.
 */

const LEGAL_SUFFIXES = [
  'limited', 'ltd', 'llp', 'lp', 'plc', 'llc', 'inc', 'incorporated',
  'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'bv', 'nv',
  'sarl', 'sa', 'srl', 'spa', 'ab', 'as', 'oy', 'aps', 'pty', 'pte',
  'pvt', 'private', 'sdn', 'bhd', 'kk', 'kg', 'ug', 'ug haftungsbeschrankt',
]

const NOISE_WORDS = ['the', 'and', 'of', 'at', 'in', 'for', '&']

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

/** Aggressive key used for blocking (candidate generation). */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = stripAccents(raw.toLowerCase())
  s = s.replace(/&/g, ' and ')
  s = s.replace(/[^a-z0-9\s]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()

  const tokens = s.split(' ').filter(Boolean)
  // Drop trailing legal suffixes only — "Co-op Pharmacy" must keep its "co".
  while (tokens.length > 1 && LEGAL_SUFFIXES.includes(tokens[tokens.length - 1]!)) {
    tokens.pop()
  }
  return tokens.join(' ')
}

/** Token set used for similarity, with stopwords removed. */
export function nameTokens(raw: string | null | undefined): string[] {
  return normalizeName(raw)
    .split(' ')
    .filter((t) => t.length > 0 && !NOISE_WORDS.includes(t))
}

/** Jaccard similarity over tokens: order-insensitive, robust to word additions. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a))
  const tb = new Set(nameTokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

/** Normalised Levenshtein similarity, for short names where tokens are unhelpful. */
export function stringSimilarity(a: string, b: string): number {
  const s1 = normalizeName(a)
  const s2 = normalizeName(b)
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  const dist = levenshtein(s1, s2)
  return 1 - dist / Math.max(s1.length, s2.length)
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]!
}

/** Best of both measures — names vary in length a lot across providers. */
export function nameSimilarity(a: string, b: string): number {
  return Math.max(tokenSimilarity(a, b), stringSimilarity(a, b))
}
