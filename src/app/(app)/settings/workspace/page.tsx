import { requireAuth } from '@/server/auth/guard'
import { prisma } from '@/server/db/client'
import { Badge, Card, CardHeader } from '@/components/ui/primitives'
import { formatDate, formatNumber } from '@/lib/utils'
import { usageSummary } from '@/server/usage/record'

export const metadata = { title: 'Workspace' }
export const dynamic = 'force-dynamic'

export default async function WorkspacePage() {
  const auth = await requireAuth()

  const [workspace, members, counts, usage] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: auth.workspaceId } }),
    prisma.membership.findMany({
      where: { workspaceId: auth.workspaceId },
      include: { user: { select: { name: true, email: true, lastLoginAt: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    Promise.all([
      prisma.business.count({ where: { workspaceId: auth.workspaceId } }),
      prisma.audit.count({ where: { business: { workspaceId: auth.workspaceId } } }),
      prisma.auditIssue.count({
        where: { audit: { business: { workspaceId: auth.workspaceId } } },
      }),
      prisma.discoveryJob.count({ where: { workspaceId: auth.workspaceId } }),
    ]),
    usageSummary(auth.workspaceId, 30),
  ])

  const [businesses, audits, issues, jobs] = counts

  // Aggregate the daily usage ledger into a per-provider total for the period.
  const byProvider = new Map<string, number>()
  for (const u of usage) {
    byProvider.set(u.provider, (byProvider.get(u.provider) ?? 0) + u.units)
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Workspace" />
        <dl className="grid gap-4 px-5 py-4 text-[13px] sm:grid-cols-2">
          <Row label="Name" value={workspace?.name ?? '—'} />
          <Row label="Slug" value={workspace?.slug ?? '—'} />
          <Row label="Created" value={formatDate(workspace?.createdAt ?? null)} />
          <Row
            label="Data retention"
            value={
              workspace?.retentionDays
                ? `${workspace.retentionDays} days`
                : 'Kept indefinitely'
            }
          />
        </dl>
      </Card>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Businesses" value={businesses} />
        <Stat label="Audits" value={audits} />
        <Stat label="Findings" value={issues} />
        <Stat label="Discovery jobs" value={jobs} />
      </div>

      <Card>
        <CardHeader title="Members" description="Everyone with access to this workspace's data" />
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{m.user.name ?? m.user.email}</div>
                <div className="text-2xs text-subtle">
                  {m.user.email} · last signed in{' '}
                  {m.user.lastLoginAt ? formatDate(m.user.lastLoginAt) : 'never'}
                </div>
              </div>
              <Badge tone={m.role === 'OWNER' ? 'accent' : 'outline'}>{m.role}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Provider usage"
          description="External calls made in the last 30 days (§33)"
        />
        {byProvider.size === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted">
            No external provider calls recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {Array.from(byProvider.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([provider, units]) => (
                <li key={provider} className="flex items-center justify-between px-5 py-2.5 text-[13px]">
                  <span className="font-medium">{provider}</span>
                  <span className="tnum text-muted">{formatNumber(units)} calls</span>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Compliance" description="§30 — how this workspace collects data" />
        <ul className="space-y-2 px-5 py-4 text-[13px] leading-5 text-muted">
          <li>Discovery uses official provider APIs and permitted public sources only.</li>
          <li>The crawler identifies itself, respects robots.txt and rate-limits itself per host.</li>
          <li>No CAPTCHA solving, bot-protection evasion or prohibited scraping is implemented.</li>
          <li>Contact data is collected only where it is published publicly by the business.</li>
          <li>This application never sends outreach. Contact status is recorded manually.</li>
        </ul>
      </Card>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="px-4 py-3">
      <div className="tnum text-xl font-semibold">{formatNumber(value)}</div>
      <div className="mt-0.5 text-2xs text-muted">{label}</div>
    </Card>
  )
}
