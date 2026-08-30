/**
 * Industry / keyword expansion (§2).
 *
 * The user's own term is always executed first and is always flagged
 * `isExpanded: false`. Expansions are additional queries, clearly marked, so the
 * coverage report can honestly say "we searched these 5 terms", and a user who
 * distrusts the expansions can switch them off.
 */

export interface ExpandedTerm {
  term: string
  isExpanded: boolean
  originTerm: string
}

/**
 * Curated synonym sets. Deliberately hand-written rather than model-generated:
 * a hallucinated expansion ("plumber" → "plumbing supplies wholesaler") pollutes
 * the result set with businesses the user did not ask for.
 */
const SYNONYMS: Record<string, string[]> = {
  plumber: ['plumbing company', 'emergency plumber', 'plumbing contractor', 'drain service'],
  dentist: ['dental clinic', 'dental practice', 'orthodontist', 'cosmetic dentist'],
  restaurant: ['bistro', 'eatery', 'dining', 'brasserie'],
  cafe: ['coffee shop', 'coffeehouse', 'espresso bar'],
  electrician: ['electrical contractor', 'emergency electrician', 'electrical services'],
  roofer: ['roofing company', 'roofing contractor', 'roof repair'],
  lawyer: ['solicitor', 'law firm', 'legal services', 'attorney'],
  accountant: ['accounting firm', 'bookkeeping service', 'tax accountant', 'chartered accountant'],
  builder: ['construction company', 'building contractor', 'home builder'],
  landscaper: ['landscaping company', 'garden services', 'lawn care'],
  'estate agent': ['real estate agency', 'letting agent', 'property agent'],
  gym: ['fitness centre', 'health club', 'personal training studio'],
  salon: ['hair salon', 'beauty salon', 'hairdresser'],
  barber: ['barbershop', "men's grooming"],
  vet: ['veterinary clinic', 'veterinary surgery', 'animal hospital'],
  physiotherapist: ['physiotherapy clinic', 'physical therapy', 'sports injury clinic'],
  chiropractor: ['chiropractic clinic', 'spine clinic'],
  optician: ['optometrist', 'eye care centre', 'eyewear store'],
  pharmacy: ['chemist', 'drugstore'],
  florist: ['flower shop', 'flower delivery'],
  bakery: ['patisserie', 'bread shop'],
  butcher: ['meat shop', 'butchery'],
  'car repair': ['auto repair shop', 'garage', 'mechanic', 'mot centre'],
  'car dealer': ['car dealership', 'used car dealer', 'auto sales'],
  locksmith: ['emergency locksmith', 'lock repair'],
  cleaner: ['cleaning company', 'commercial cleaning', 'domestic cleaning'],
  photographer: ['photography studio', 'wedding photographer'],
  printer: ['printing company', 'print shop'],
  architect: ['architecture firm', 'architectural services'],
  'driving school': ['driving instructor', 'driving lessons'],
  nursery: ['day nursery', 'childcare centre', 'preschool'],
  hotel: ['guest house', 'bed and breakfast', 'inn'],
  'travel agent': ['travel agency', 'tour operator'],
  'insurance broker': ['insurance agency', 'insurance services'],
  'mortgage broker': ['mortgage advisor', 'mortgage services'],
  tattoo: ['tattoo studio', 'tattoo parlour'],
  'pet groomer': ['dog grooming', 'pet grooming salon'],
  'removal company': ['moving company', 'house removals', 'man and van'],
  glazier: ['double glazing', 'window installer', 'glass repair'],
  'pest control': ['exterminator', 'pest removal'],
  scaffolding: ['scaffolding contractor', 'scaffold hire'],
  'skip hire': ['waste removal', 'rubbish clearance'],
  joiner: ['carpenter', 'joinery', 'bespoke furniture maker'],
  painter: ['painter and decorator', 'decorating services'],
  tiler: ['tiling contractor', 'tile installer'],
  'kitchen fitter': ['kitchen installation', 'kitchen showroom'],
  'bathroom fitter': ['bathroom installation', 'bathroom showroom'],
  'solar installer': ['solar panel installation', 'renewable energy installer'],
  'heating engineer': ['boiler repair', 'gas engineer', 'central heating'],
}

/** Generic patterns applied when we have no curated set for the term. */
const GENERIC_PATTERNS = [
  (t: string) => `${t} company`,
  (t: string) => `${t} services`,
  (t: string) => `local ${t}`,
  (t: string) => `${t} near me`,
]

function canonical(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Strip a plural "s" so "dentists" finds the "dentist" synonym set. */
function singularize(term: string): string {
  if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`
  if (term.endsWith('sses')) return term.slice(0, -2)
  if (term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
  return term
}

export function expandTerms(options: {
  industry: string
  categories?: string[]
  keywords?: string[]
  enabled: boolean
  /** Cap so expansion cannot multiply cost without bound. */
  max?: number
}): ExpandedTerm[] {
  const { industry, categories = [], keywords = [], enabled, max = 6 } = options

  const out: ExpandedTerm[] = []
  const seen = new Set<string>()

  const push = (term: string, isExpanded: boolean, origin: string) => {
    const c = canonical(term)
    if (!c || seen.has(c)) return
    seen.add(c)
    out.push({ term: c, isExpanded, originTerm: origin })
  }

  // 1. The user's own words, always, first, unexpanded.
  push(industry, false, industry)
  for (const c of categories) push(c, false, c)
  for (const k of keywords) push(k, false, k)

  if (!enabled) return out

  // 2. Curated synonyms for the primary industry term.
  const base = canonical(industry)
  const key = SYNONYMS[base] ? base : singularize(base)
  const synonyms = SYNONYMS[key]

  if (synonyms) {
    for (const s of synonyms) {
      if (out.length >= max) break
      push(s, true, industry)
    }
  } else {
    for (const pattern of GENERIC_PATTERNS) {
      if (out.length >= max) break
      push(pattern(base), true, industry)
    }
  }

  return out.slice(0, Math.max(1, max))
}

/** Exclusion matching (§1) — applied post-fetch against name and categories. */
export function isExcluded(
  business: { name: string; categories?: string[]; category?: string | null },
  exclusions: string[],
): boolean {
  if (exclusions.length === 0) return false
  const haystack = [
    business.name,
    business.category ?? '',
    ...(business.categories ?? []),
  ]
    .join(' ')
    .toLowerCase()
  return exclusions.some((ex) => {
    const e = canonical(ex)
    return e.length > 0 && haystack.includes(e)
  })
}

export const SYNONYM_INDUSTRIES = Object.keys(SYNONYMS).sort()
