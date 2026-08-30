import { requireAuth } from '@/server/auth/guard'
import {
  computeDailyTotals,
  dayKey,
  dayRange,
  reportsForRange,
} from '@/server/crm/reports'
import { reportingTimeZone } from '@/server/crm/settings'
import { AgentResults } from '@/components/agent/agent-results'

export const metadata = { title: 'My results' }
export const dynamic = 'force-dynamic'

/**
 * The agent's own numbers.
 *
 * Today is computed live rather than read from a stored report, because the
 * day has not been rolled up yet and an agent checking their progress at 2pm
 * needs the current figure, not this morning's snapshot. Previous days come
 * from the stored reports, which is what the supervisor sees too — so the two
 * never disagree.
 */
export default async function AgentReportsPage() {
  const auth = await requireAuth()
  const timeZone = await reportingTimeZone(auth.workspaceId)

  const today = dayKey(new Date(), timeZone)
  const from = dayKey(new Date(Date.now() - 29 * 86_400_000), timeZone)
  const { start, end } = dayRange(today, timeZone)

  const [live, history] = await Promise.all([
    computeDailyTotals({ workspaceId: auth.workspaceId, userId: auth.userId, start, end }),
    reportsForRange({
      workspaceId: auth.workspaceId,
      from,
      to: today,
      userId: auth.userId,
    }),
  ])

  return (
    <AgentResults
      today={today}
      timeZone={timeZone}
      live={{
        calls: live.calls,
        reached: live.reached,
        leadsWorked: live.leadsWorked,
        followUpsSet: live.followUpsSet,
        meetingsBooked: live.meetingsBooked,
        sales: live.sales,
        interested: live.interested,
        activeMinutes: live.activeMinutes,
        shiftMinutes: live.shiftMinutes,
        contactRate: live.calls > 0 ? Math.round((live.reached / live.calls) * 100) : null,
      }}
      // Today's stored row, if the day was rolled up early, would duplicate the
      // live figures above — so it is left out of the history list.
      history={history
        .filter((r) => r.day !== today)
        .map((r) => ({
          day: r.day,
          calls: r.calls,
          reached: r.reached,
          leadsWorked: r.leadsWorked,
          meetingsBooked: r.meetingsBooked,
          sales: r.sales,
          activeMinutes: r.activeMinutes,
          shiftMinutes: r.shiftMinutes,
          contactRate: r.contactRate,
          callsPerHour: r.callsPerHour,
        }))}
    />
  )
}
