import 'server-only'
import { prisma } from '@/server/db/client'

/** §33 — provider call accounting and daily caps. */

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function recordUsage(opts: {
  workspaceId: string
  provider: string
  operation: string
  units?: number
  costUsd?: number
  cached?: boolean
}): Promise<void> {
  await prisma.usageRecord.create({
    data: {
      workspaceId: opts.workspaceId,
      provider: opts.provider,
      operation: opts.operation,
      units: opts.units ?? 1,
      costUsd: opts.costUsd,
      cached: opts.cached ?? false,
      day: today(),
    },
  })
}

export async function usageToday(
  workspaceId: string,
  provider: string,
  operation?: string,
): Promise<number> {
  const agg = await prisma.usageRecord.aggregate({
    where: {
      workspaceId,
      provider,
      day: today(),
      cached: false,
      ...(operation ? { operation } : {}),
    },
    _sum: { units: true },
  })
  return agg._sum.units ?? 0
}

export function currentMonthBounds(now = new Date()): { startDay: string; endDay: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return {
    startDay: start.toISOString().slice(0, 10),
    endDay: end.toISOString().slice(0, 10),
  }
}

export async function usageThisMonth(
  workspaceId: string,
  providers: string | string[],
  operation?: string,
): Promise<number> {
  const { startDay, endDay } = currentMonthBounds()
  const providerList = Array.isArray(providers) ? providers : [providers]
  const agg = await prisma.usageRecord.aggregate({
    where: {
      workspaceId,
      provider: { in: providerList },
      day: { gte: startDay, lt: endDay },
      cached: false,
      ...(operation ? { operation } : {}),
    },
    _sum: { units: true },
  })
  return agg._sum.units ?? 0
}

/** Returns true when the caller is still within the configured daily budget. */
export async function withinDailyLimit(
  workspaceId: string,
  provider: string,
  limit: number,
): Promise<boolean> {
  if (limit <= 0) return true
  return (await usageToday(workspaceId, provider)) < limit
}

export async function usageSummary(workspaceId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const rows = await prisma.usageRecord.groupBy({
    by: ['provider', 'day'],
    where: { workspaceId, day: { gte: since } },
    _sum: { units: true, costUsd: true },
  })
  return rows.map((r) => ({
    provider: r.provider,
    day: r.day,
    units: r._sum.units ?? 0,
    costUsd: r._sum.costUsd ?? null,
  }))
}
