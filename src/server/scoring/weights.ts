import { z } from 'zod'

/**
 * Scoring configuration (§14 — "make scoring weights configurable rather than
 * hard-coded throughout the application").
 *
 * Every number that influences a score lives here, is validated, is persisted
 * per workspace in ScoringProfile.weights, and is editable in Settings → Scoring.
 */

export const scoringWeightsSchema = z.object({
  /** Penalty points deducted from 100 per issue, before the confidence multiplier. */
  severity: z.object({
    CRITICAL: z.number().min(0).max(100).default(22),
    HIGH: z.number().min(0).max(100).default(12),
    MEDIUM: z.number().min(0).max(100).default(6),
    LOW: z.number().min(0).max(100).default(2),
    INFO: z.number().min(0).max(100).default(0),
  }),
  /** Multiplier applied to the penalty, by finding confidence. */
  confidence: z.object({
    HIGH: z.number().min(0).max(1).default(1),
    MEDIUM: z.number().min(0).max(1).default(0.7),
    LOW: z.number().min(0).max(1).default(0.4),
  }),

  /** Composition of the overall Website Health score from the four domains. */
  websiteHealth: z.object({
    seo: z.number().min(0).max(1).default(0.3),
    performance: z.number().min(0).max(1).default(0.25),
    ux: z.number().min(0).max(1).default(0.27),
    technical: z.number().min(0).max(1).default(0.18),
  }),

  opportunity: z.object({
    /** How much the inverse of health drives opportunity. */
    healthGap: z.number().min(0).max(1).default(0.6),
    /** How much the volume/severity of concrete evidence adds. */
    evidenceStrength: z.number().min(0).max(1).default(0.25),
    /** How much a credible, valuable-looking business adds. */
    businessValue: z.number().min(0).max(1).default(0.15),
    /** Deduction applied when the evidence is thin or low-confidence. */
    uncertaintyPenalty: z.number().min(0).max(1).default(0.2),
    /** An opportunity below this score is not flagged as triggered. */
    triggerThreshold: z.number().min(0).max(100).default(45),
  }),

  /**
   * Lead priority (§15). Deliberately not dominated by "worst website" —
   * need is only one of four inputs.
   */
  leadPriority: z.object({
    need: z.number().min(0).max(1).default(0.4),
    contactability: z.number().min(0).max(1).default(0.22),
    credibility: z.number().min(0).max(1).default(0.23),
    evidence: z.number().min(0).max(1).default(0.15),
    hotThreshold: z.number().min(0).max(100).default(75),
    warmThreshold: z.number().min(0).max(100).default(50),
  }),

  /** Points contributing to Business Data Confidence (0-100). */
  dataConfidence: z.object({
    perSource: z.number().min(0).max(100).default(18),
    hasPhone: z.number().min(0).max(100).default(14),
    hasEmail: z.number().min(0).max(100).default(10),
    hasAddress: z.number().min(0).max(100).default(12),
    hasCoordinates: z.number().min(0).max(100).default(8),
    hasWebsite: z.number().min(0).max(100).default(10),
    hasReviews: z.number().min(0).max(100).default(10),
    websiteVerified: z.number().min(0).max(100).default(12),
    demoPenalty: z.number().min(0).max(100).default(55),
  }),

  /** Speed opportunity thresholds. */
  speed: z.object({
    poorScore: z.number().min(0).max(100).default(50),
    weakScore: z.number().min(0).max(100).default(75),
    mobileWeight: z.number().min(0).max(1).default(0.7),
  }),
})

export type ScoringWeights = z.infer<typeof scoringWeightsSchema>

export const DEFAULT_WEIGHTS: ScoringWeights = scoringWeightsSchema.parse({
  severity: {},
  confidence: {},
  websiteHealth: {},
  opportunity: {},
  leadPriority: {},
  dataConfidence: {},
  speed: {},
})

/** Tolerant parse: a corrupt or partial profile falls back to defaults per key. */
export function parseWeights(raw: unknown): ScoringWeights {
  const result = scoringWeightsSchema.safeParse(raw)
  if (result.success) return result.data
  const merged = {
    ...DEFAULT_WEIGHTS,
    ...(typeof raw === 'object' && raw !== null ? raw : {}),
  }
  const second = scoringWeightsSchema.safeParse(merged)
  return second.success ? second.data : DEFAULT_WEIGHTS
}
