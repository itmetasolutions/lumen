import { describe, it, expect } from 'vitest'
import { OUTCOMES, TERMINAL_OUTCOMES, outcomeMeta, outcomeLabel } from '@/server/crm/outcomes'
import { dayKey, dayRange, summarise } from '@/server/crm/reports'
import { derivePresence } from '@/server/crm/sessions'
import { isValidTimeZone } from '@/server/crm/settings'
import { normaliseServerUrl } from '../electron/server-url'

/**
 * Cold-calling CRM.
 *
 * The rules worth pinning down here are the ones a screen could quietly get
 * wrong: what counts as reaching someone, which outcomes end a lead, and where
 * a working day begins and ends.
 */

describe('call outcomes', () => {
  it('treats voicemail and no-answer as attempts, not contact', () => {
    expect(outcomeMeta('VOICEMAIL').reached).toBe(false)
    expect(outcomeMeta('NO_ANSWER').reached).toBe(false)
    expect(outcomeMeta('BUSY').reached).toBe(false)
  })

  it('counts a gatekeeper conversation as contact', () => {
    // Someone at the business answered and spoke — that is a contact even
    // though it was not the decision-maker.
    expect(outcomeMeta('GATEKEEPER').reached).toBe(true)
  })

  it('requires a follow-up for every outcome that promises one', () => {
    for (const value of ['CALLBACK_REQUESTED', 'GATEKEEPER', 'INTERESTED', 'MEETING_BOOKED'] as const) {
      expect(outcomeMeta(value).followUp).toBe('required')
    }
  })

  it('forbids a follow-up on outcomes that end contact permanently', () => {
    expect(outcomeMeta('DO_NOT_CALL').followUp).toBe('forbidden')
    expect(outcomeMeta('WRONG_NUMBER').followUp).toBe('forbidden')
  })

  it('never marks an outcome both terminal and requiring a follow-up', () => {
    // A lead cannot simultaneously be closed and owe a next action.
    for (const o of OUTCOMES) {
      expect(o.terminal && o.followUp === 'required').toBe(false)
    }
  })

  it('closes the lead on a sale, a refusal and a do-not-call', () => {
    expect(TERMINAL_OUTCOMES).toContain('SALE')
    expect(TERMINAL_OUTCOMES).toContain('NOT_INTERESTED')
    expect(TERMINAL_OUTCOMES).toContain('DO_NOT_CALL')
    expect(TERMINAL_OUTCOMES).not.toContain('CALLBACK_REQUESTED')
  })

  it('sends do-not-call to the do-not-contact stage', () => {
    expect(outcomeMeta('DO_NOT_CALL').stage).toBe('DO_NOT_CONTACT')
  })

  it('leaves the outreach stage alone for an unanswered call', () => {
    // An attempt says nothing about the relationship, so it must not overwrite
    // a stage a real conversation established earlier.
    expect(outcomeMeta('NO_ANSWER').stage).toBeNull()
    expect(outcomeMeta('VOICEMAIL').stage).toBeNull()
  })

  it('says "Never called" rather than blank for a lead with no outcome', () => {
    expect(outcomeLabel(null)).toBe('Never called')
    expect(outcomeLabel('MEETING_BOOKED')).toBe('Meeting booked')
  })

  it('has a unique value for every outcome', () => {
    expect(new Set(OUTCOMES.map((o) => o.value)).size).toBe(OUTCOMES.length)
  })
})

describe('the working day', () => {
  it('resolves the local calendar day, not the UTC one', () => {
    // 23:30 UTC is already the next day in Karachi.
    const at = new Date('2026-03-10T23:30:00Z')
    expect(dayKey(at, 'UTC')).toBe('2026-03-10')
    expect(dayKey(at, 'Asia/Karachi')).toBe('2026-03-11')
  })

  it('spans exactly 24 hours on an ordinary day', () => {
    const { start, end } = dayRange('2026-06-15', 'Europe/London')
    expect(end.getTime() - start.getTime()).toBe(86_400_000)
  })

  it('is 23 hours on the day the clocks go forward', () => {
    // Europe/London springs forward at 01:00 UTC on 29 March 2026.
    const { start, end } = dayRange('2026-03-29', 'Europe/London')
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23)
    expect(start.toISOString()).toBe('2026-03-29T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-03-29T23:00:00.000Z')
  })

  it('is 25 hours on the day the clocks go back', () => {
    const { start, end } = dayRange('2026-10-25', 'Europe/London')
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25)
  })

  it('handles a timezone with a half-hour offset', () => {
    const { start } = dayRange('2026-06-15', 'Asia/Kolkata')
    expect(start.toISOString()).toBe('2026-06-14T18:30:00.000Z')
  })

  it('rolls over the year boundary', () => {
    const { start, end } = dayRange('2026-12-31', 'UTC')
    expect(start.toISOString()).toBe('2026-12-31T00:00:00.000Z')
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('produces a range that contains the day it names', () => {
    for (const tz of ['UTC', 'Europe/London', 'America/New_York', 'Asia/Karachi']) {
      const { start, end } = dayRange('2026-08-30', tz)
      expect(dayKey(start, tz)).toBe('2026-08-30')
      expect(dayKey(new Date(end.getTime() - 1), tz)).toBe('2026-08-30')
      // The end instant itself belongs to the next day.
      expect(dayKey(end, tz)).toBe('2026-08-31')
    }
  })
})

describe('presence', () => {
  it('reports a recent heartbeat as online', () => {
    expect(derivePresence(new Date(Date.now() - 10_000), 'online')).toBe('online')
  })

  it('goes idle, then offline, as the heartbeat ages', () => {
    expect(derivePresence(new Date(Date.now() - 120_000), 'online')).toBe('idle')
    expect(derivePresence(new Date(Date.now() - 600_000), 'online')).toBe('offline')
  })

  it('never resurrects someone who clocked out', () => {
    expect(derivePresence(new Date(), 'offline')).toBe('offline')
  })
})

describe('report summaries', () => {
  const row = (over: Partial<Record<string, number>> = {}) =>
    ({
      userId: 'u1', name: 'A', email: 'a@b.c', avatarPath: null, day: '2026-08-30',
      calls: 0, reached: 0, leadsWorked: 0, followUpsSet: 0, meetingsBooked: 0,
      sales: 0, interested: 0, notInterested: 0, doNotCall: 0,
      activeMinutes: 0, shiftMinutes: 0, firstActivityAt: null, lastActivityAt: null,
      outcomes: {}, contactRate: null, callsPerHour: null,
      ...over,
    }) as never

  it('reports an unknown contact rate rather than zero when nobody called', () => {
    // 0% reads as a terrible day; the truth is there is no rate to report.
    expect(summarise([row()]).contactRate).toBeNull()
  })

  it('computes the rate across the whole range, not per row', () => {
    const s = summarise([row({ calls: 10, reached: 5 }), row({ calls: 10, reached: 1 })])
    expect(s.calls).toBe(20)
    expect(s.contactRate).toBe(30)
  })

  it('leaves calls per hour unknown when no active time was recorded', () => {
    expect(summarise([row({ calls: 12 })]).callsPerHour).toBeNull()
  })

  it('counts distinct agents and days rather than rows', () => {
    const s = summarise([
      row({ calls: 1 }),
      { ...(row({ calls: 1 }) as object), userId: 'u2' } as never,
      { ...(row({ calls: 1 }) as object), day: '2026-08-29' } as never,
    ])
    expect(s.agents).toBe(2)
    expect(s.days).toBe(2)
  })
})

describe('timezone validation', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true)
    expect(isValidTimeZone('Asia/Karachi')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
  })

  it('rejects anything the formatter cannot resolve', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('agent app server address', () => {
  it('accepts what someone would actually be told over a desk', () => {
    expect(normaliseServerUrl('192.168.1.10:3210')).toBe('http://192.168.1.10:3210')
    expect(normaliseServerUrl('  lumen.local:3210  ')).toBe('http://lumen.local:3210')
  })

  it('keeps an explicit scheme', () => {
    expect(normaliseServerUrl('https://lumen.example.com')).toBe('https://lumen.example.com')
  })

  it('trims to the origin, since the app supplies its own routes', () => {
    expect(normaliseServerUrl('http://10.0.0.5:3210/agent?x=1')).toBe('http://10.0.0.5:3210')
  })

  it('rejects a non-http scheme', () => {
    expect(normaliseServerUrl('file:///etc/passwd')).toBeNull()
    expect(normaliseServerUrl('javascript:alert(1)')).toBeNull()
  })

  it('treats nothing as nothing', () => {
    expect(normaliseServerUrl('')).toBeNull()
    expect(normaliseServerUrl(null)).toBeNull()
    expect(normaliseServerUrl('   ')).toBeNull()
  })
})
