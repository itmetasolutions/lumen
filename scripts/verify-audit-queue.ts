/**
 * Live check for bulk audit queueing.
 *
 * Confirms the dry run reports accurately, that a real run enqueues exactly what
 * it promised, and — the property that matters most — that running it twice does
 * not queue the same business again.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-audit-queue.ts
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

const line = (l: string, v: unknown) => console.log(`  ${l.padEnd(28)} ${String(v)}`)

async function main() {
  const { prisma } = await import('../src/server/db/client')
  const { queueMissingAudits } = await import('../src/server/leads/audit-queue')

  const ws = await prisma.workspace.findFirst({
    where: { businesses: { some: { auditStatus: 'NOT_AUDITED' } } },
    select: { id: true, name: true },
  })
  if (!ws) {
    console.log('\n  Nothing unaudited anywhere — nothing to verify.\n')
    await prisma.$disconnect()
    return
  }

  console.log('\n── Workspace ─────────────────────────────────────────────────')
  line('name', ws.name)

  console.log('\n── 1. Dry run ────────────────────────────────────────────────')
  const plan = await queueMissingAudits({ workspaceId: ws.id, dryRun: true })
  line('matched', plan.matched)
  line('  with a website', plan.withWebsite)
  line('  without a website', plan.withoutWebsite)
  line('queued (should be 0)', plan.queued)

  let failed = 0
  if (plan.queued !== 0) {
    console.log('  ✗ dry run enqueued work')
    failed++
  } else {
    console.log('  ✓ dry run changed nothing')
  }

  const queuedBefore = await prisma.queueJob.count({
    where: { queue: 'audit', state: 'WAITING' },
  })

  console.log('\n── 2. Real run (capped at 10) ────────────────────────────────')
  const run = await queueMissingAudits({ workspaceId: ws.id, limit: 10 })
  line('queued', run.queued)
  line('capped', run.capped)

  const queuedAfter = await prisma.queueJob.count({
    where: { queue: 'audit', state: 'WAITING' },
  })
  line('queue grew by', queuedAfter - queuedBefore)

  if (queuedAfter - queuedBefore === run.queued && run.queued > 0) {
    console.log('  ✓ jobs actually landed in the queue')
  } else {
    console.log('  ✗ queue growth does not match the reported count')
    failed++
  }

  console.log('\n── 3. Re-run must not double-queue ───────────────────────────')
  const second = await queueMissingAudits({ workspaceId: ws.id, dryRun: true })
  line('still matched', second.matched)
  line('difference', plan.matched - second.matched)

  if (second.matched === plan.matched - run.queued) {
    console.log('  ✓ the businesses just queued are no longer selected')
  } else {
    console.log('  ✗ selection did not shrink by the number queued')
    failed++
  }

  // The payloads must be well formed or the worker will dead-letter them.
  const sample = await prisma.queueJob.findFirst({
    where: { queue: 'audit', state: 'WAITING' },
    orderBy: { createdAt: 'desc' },
    select: { name: true, payload: true },
  })
  console.log('\n── 4. Payload shape ──────────────────────────────────────────')
  const payload = sample?.payload as Record<string, unknown> | undefined
  line('job name', sample?.name)
  line('businessId', payload?.businessId ? 'present' : 'MISSING')
  line('workspaceId', payload?.workspaceId ? 'present' : 'MISSING')
  line('depth', payload?.depth)
  line('trigger', payload?.trigger)

  if (!payload?.businessId || !payload?.workspaceId) {
    console.log('  ✗ payload is missing required fields')
    failed++
  } else {
    console.log('  ✓ payload is complete')
  }

  await prisma.$disconnect()

  if (failed > 0) {
    console.log(`\n❌ ${failed} check(s) failed\n`)
    process.exit(1)
  }
  console.log('\n✅ Bulk audit queueing behaves correctly\n')
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
