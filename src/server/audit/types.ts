import type { Confidence, IssueCategory, Severity } from '@prisma/client'

/**
 * The audit-time shape of a finding, before it is persisted as an AuditIssue (§11).
 *
 * `evidence` is mandatory and must be *machine-collected*: a selector that was
 * queried, a value that was measured, a URL that returned a status. "Looks
 * outdated" is not evidence and cannot be expressed in this type.
 */
export interface IssueDraft {
  type: string
  category: IssueCategory
  severity: Severity
  confidence: Confidence
  title: string
  description: string
  evidence: Record<string, unknown>
  affectedUrl?: string | null
  source?: 'DETERMINISTIC' | 'AI_ASSISTED' | 'PROVIDER'
  recommendedAction: string
}

export type StageOutcome<T> =
  | { status: 'OK'; data: T; issues: IssueDraft[] }
  | { status: 'SKIPPED'; reason: string; issues: IssueDraft[] }
  | { status: 'FAILED'; error: string; issues: IssueDraft[] }

export function ok<T>(data: T, issues: IssueDraft[] = []): StageOutcome<T> {
  return { status: 'OK', data, issues }
}

export function skipped<T>(reason: string): StageOutcome<T> {
  return { status: 'SKIPPED', reason, issues: [] }
}

export function failed<T>(error: string): StageOutcome<T> {
  return { status: 'FAILED', error, issues: [] }
}

/** Severity → penalty points applied against a 100-point health score. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 22,
  HIGH: 12,
  MEDIUM: 6,
  LOW: 2,
  INFO: 0,
}

/** Low-confidence findings should not dent a score as hard as certain ones. */
export const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  HIGH: 1,
  MEDIUM: 0.7,
  LOW: 0.4,
}
