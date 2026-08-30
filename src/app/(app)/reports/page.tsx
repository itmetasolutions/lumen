import { redirect } from 'next/navigation'
import { requireAuth } from '@/server/auth/guard'
import { dayKey, reportsForRange, summarise } from '@/server/crm/reports'
import { reportingTimeZone } from '@/server/crm/settings'
import { listTeam } from '@/server/crm/team'
import { ReportsView } from '@/components/crm/reports-view'

export const metadata = { title: 'Reports' }
export const dynamic = 'force-dynamic'

/**
 * Daily reports.
 *
 * The default range is the last 14 days, ending today — long enough to see a
 * trend, short enough to read. The first render is server-side so the page is
 * useful immediately; changing the range refetches.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; userId?: string }>
}) {
  const auth = await requireAuth()
  if (auth.role !== 'OWNER' && auth.role !== 'ADMIN') redirect('/agent/reports')

  const params = await searchParams
  const timeZone = await reportingTimeZone(auth.workspaceId)

  const today = dayKey(new Date(), timeZone)
  const defaultFrom = dayKey(new Date(Date.now() - 13 * 86_400_000), timeZone)

  const from = isDay(params.from) ? params.from : defaultFrom
  const to = isDay(params.to) ? params.to : today

  const rows = await reportsForRange({
    workspaceId: auth.workspaceId,
    from,
    to,
    userId: params.userId,
  })

  const team = await listTeam(auth.workspaceId)

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <ReportsView
        initialRows={rows.map((r) => ({
          ...r,
          firstActivityAt: r.firstActivityAt?.toISOString() ?? null,
          lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
        }))}
        initialSummary={summarise(rows)}
        from={from}
        to={to}
        today={today}
        timeZone={timeZone}
        selectedUserId={params.userId ?? null}
        agents={team
          .filter((m) => m.isActive)
          .map((m) => ({ id: m.userId, name: m.name ?? m.email }))}
      />
    </div>
  )
}

function isDay(v: string | undefined): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}
