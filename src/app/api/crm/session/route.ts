import { z } from 'zod'
import { requireRole } from '@/server/auth/guard'
import { clockIn, clockOut, currentSession, touchPresence } from '@/server/crm/sessions'
import { route, HttpError } from '@/app/api/_lib/handler'

/**
 * Shift control and the heartbeat.
 *
 * The heartbeat is what turns "the app is open" into a measurement: the server
 * credits the gap since the last beat, capped, so active time is derived from
 * observed liveness rather than from a duration the client reports.
 *
 * `limit: 'read'` on the heartbeat is deliberate — it fires every 30 seconds
 * per agent and must not exhaust a write budget shared with call logging.
 */

const schema = z.object({
  action: z.enum(['in', 'out', 'heartbeat', 'status']),
  /** Which lead the agent is looking at, for the supervisor view. */
  currentBusinessId: z.string().max(40).nullish(),
  /** The agent is present but not working — a break, not a clock-out. */
  idle: z.boolean().default(false),
})

export const POST = route({ schema, limit: 'read' }, async ({ auth, body }) => {
  requireRole(auth, 'AGENT')

  switch (body.action) {
    case 'in': {
      const session = await clockIn(auth.workspaceId, auth.userId)
      return { session, clockedIn: true }
    }

    case 'out': {
      const closed = await clockOut(auth.workspaceId, auth.userId, 'manual')
      if (!closed) throw new HttpError(409, 'You are not clocked in')
      return { ...closed, clockedIn: false }
    }

    case 'heartbeat': {
      const session = await currentSession(auth.workspaceId, auth.userId)
      // A heartbeat without an open shift still refreshes presence, so a
      // supervisor can see someone is in the app but has not started.
      const { activeSeconds } = await touchPresence({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        sessionId: session?.id ?? null,
        currentBusinessId: body.currentBusinessId ?? undefined,
        status: body.idle ? 'idle' : 'online',
      })
      return {
        clockedIn: Boolean(session),
        session: session ? { ...session, activeSeconds: activeSeconds ?? session.activeSeconds } : null,
      }
    }

    case 'status': {
      const session = await currentSession(auth.workspaceId, auth.userId)
      return { clockedIn: Boolean(session), session }
    }
  }
})
