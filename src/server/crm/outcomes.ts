import type { CallOutcome, ContactStage } from '@prisma/client'

/**
 * The call-outcome vocabulary.
 *
 * Everything downstream — the agent's disposition form, the follow-up rules,
 * the daily report, the supervisor view — reads this table rather than
 * re-deciding what an outcome means. Two properties in particular are *rules*,
 * not presentation:
 *
 * - `reached` says whether a human at the business actually spoke to the agent.
 *   Contact rate is the number a supervisor judges an agent on, so it must not
 *   be a per-screen guess: voicemail is not contact, a gatekeeper is.
 * - `followUp` says whether a next action is mandatory. The agent app refuses
 *   to close a call with `required` unless a date is set, which is what makes
 *   the record complete rather than merely present.
 */

export type FollowUpRule = 'required' | 'optional' | 'forbidden'

export interface OutcomeMeta {
  value: CallOutcome
  label: string
  /** Did a person at the business actually speak to the agent? */
  reached: boolean
  followUp: FollowUpRule
  /** Ends the lead — no further calling. */
  terminal: boolean
  /** Counts as a positive result in the daily report. */
  positive: boolean
  /** Matches the Badge tone vocabulary, so the UI never re-maps these. */
  tone: 'neutral' | 'info' | 'ok' | 'warn' | 'danger'
  hint: string
  /** Outreach stage to move the lead to. Null leaves the current stage alone. */
  stage: ContactStage | null
}

export const OUTCOMES: OutcomeMeta[] = [
  {
    value: 'NO_ANSWER',
    label: 'No answer',
    reached: false,
    followUp: 'optional',
    terminal: false,
    positive: false,
    tone: 'neutral',
    hint: 'Rang out. Try again at a different time of day.',
    // An attempt is not a contact, so the outreach stage is left alone.
    stage: null,
  },
  {
    value: 'BUSY',
    label: 'Busy / engaged',
    reached: false,
    followUp: 'optional',
    terminal: false,
    positive: false,
    tone: 'neutral',
    hint: 'Line engaged. Worth a retry shortly.',
    // An attempt is not a contact, so the outreach stage is left alone.
    stage: null,
  },
  {
    value: 'VOICEMAIL',
    label: 'Voicemail',
    reached: false,
    followUp: 'optional',
    terminal: false,
    positive: false,
    tone: 'neutral',
    hint: 'Message left or machine reached — not a contact.',
    // An attempt is not a contact, so the outreach stage is left alone.
    stage: null,
  },
  {
    value: 'GATEKEEPER',
    label: 'Gatekeeper',
    reached: true,
    followUp: 'required',
    terminal: false,
    positive: false,
    tone: 'info',
    hint: 'Spoke to reception. Record the decision-maker and when to call back.',
    stage: 'CONTACTED',
  },
  {
    value: 'CALLBACK_REQUESTED',
    label: 'Callback requested',
    reached: true,
    followUp: 'required',
    terminal: false,
    positive: false,
    tone: 'info',
    hint: 'They asked to be called back — the time they gave is mandatory.',
    stage: 'FOLLOW_UP',
  },
  {
    value: 'INTERESTED',
    label: 'Interested',
    reached: true,
    followUp: 'required',
    terminal: false,
    positive: true,
    tone: 'ok',
    hint: 'Warm. Set the next step before you hang up.',
    stage: 'INTERESTED',
  },
  {
    value: 'MEETING_BOOKED',
    label: 'Meeting booked',
    reached: true,
    followUp: 'required',
    terminal: false,
    positive: true,
    tone: 'ok',
    hint: 'The follow-up date is the meeting itself.',
    stage: 'QUALIFIED',
  },
  {
    value: 'SALE',
    label: 'Sale / won',
    reached: true,
    followUp: 'optional',
    terminal: true,
    positive: true,
    tone: 'ok',
    hint: 'Closed. The lead leaves the calling queue.',
    stage: 'WON',
  },
  {
    value: 'NOT_INTERESTED',
    label: 'Not interested',
    reached: true,
    followUp: 'optional',
    terminal: true,
    positive: false,
    tone: 'warn',
    hint: 'Declined. Leave a note saying why — it is worth more than the outcome.',
    stage: 'NOT_INTERESTED',
  },
  {
    value: 'WRONG_NUMBER',
    label: 'Wrong number',
    reached: false,
    followUp: 'forbidden',
    terminal: true,
    positive: false,
    tone: 'warn',
    hint: 'The number does not reach this business. It will be flagged for review.',
    stage: 'LOST',
  },
  {
    value: 'DO_NOT_CALL',
    label: 'Do not call',
    reached: true,
    followUp: 'forbidden',
    terminal: true,
    positive: false,
    tone: 'danger',
    hint: 'They asked not to be contacted again. This is permanent and cannot be reassigned.',
    stage: 'DO_NOT_CONTACT',
  },
]

const BY_VALUE = new Map(OUTCOMES.map((o) => [o.value, o]))

export function outcomeMeta(outcome: CallOutcome): OutcomeMeta {
  const meta = BY_VALUE.get(outcome)
  if (!meta) throw new Error(`Unknown call outcome: ${outcome}`)
  return meta
}

export function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return 'Never called'
  return BY_VALUE.get(outcome as CallOutcome)?.label ?? outcome
}

/**
 * Outcomes that take the lead out of the calling queue. A supervisor can still
 * reopen one by reassigning it, but an agent working their queue never sees it.
 */
export const TERMINAL_OUTCOMES: CallOutcome[] = OUTCOMES.filter((o) => o.terminal).map(
  (o) => o.value,
)
