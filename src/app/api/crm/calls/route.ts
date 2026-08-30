import { z } from 'zod'
import { requireRole } from '@/server/auth/guard'
import { logCall } from '@/server/crm/calls'
import { currentSession } from '@/server/crm/sessions'
import { crmSettings } from '@/server/crm/settings'
import { route, HttpError } from '@/app/api/_lib/handler'

/**
 * Logging a call.
 *
 * The outcome vocabulary and its follow-up rules live in the service, not here,
 * so the agent app and any future caller are held to the same standard of a
 * complete record. This route's only additions are authentication and tying the
 * call to the agent's open shift.
 */

const schema = z.object({
  businessId: z.string().min(1).max(40),
  outcome: z.enum([
    'NO_ANSWER', 'BUSY', 'VOICEMAIL', 'WRONG_NUMBER', 'GATEKEEPER',
    'CALLBACK_REQUESTED', 'NOT_INTERESTED', 'INTERESTED',
    'MEETING_BOOKED', 'SALE', 'DO_NOT_CALL',
  ]),
  phoneUsed: z.string().max(40).nullish(),
  notes: z.string().max(4_000).nullish(),
  /** ISO instant the agent opened the lead, for a real handling time. */
  startedAt: z.string().datetime().nullish(),
  followUpAt: z.string().datetime().nullish(),
})

export const POST = route({ schema, limit: 'write' }, async ({ auth, body }) => {
  // Viewers may read the workspace but never write work into it.
  requireRole(auth, 'AGENT')

  const [session, settings] = await Promise.all([
    currentSession(auth.workspaceId, auth.userId),
    crmSettings(auth.workspaceId),
  ])

  // The agent app disables the save button when this applies, but the button is
  // not the rule — a call logged outside a shift would have no active time to
  // measure it against, so the workspace's policy is enforced here.
  if (settings.requireClockIn && !session) {
    throw new HttpError(409, 'Clock in before logging calls')
  }

  return logCall({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    businessId: body.businessId,
    outcome: body.outcome,
    phoneUsed: body.phoneUsed ?? null,
    notes: body.notes ?? null,
    startedAt: body.startedAt ? new Date(body.startedAt) : null,
    followUpAt: body.followUpAt ? new Date(body.followUpAt) : null,
    sessionId: session?.id ?? null,
  })
})
