/**
 * Recovery for audits that dead-lettered, and for businesses left mid-flight
 * when a worker was killed.
 *
 * Uses the queue's own mechanisms rather than editing audit data: dead jobs are
 * returned to WAITING, and businesses with no job at all get a fresh one. No
 * audit history is modified or deleted.
 *
 * Run: npx tsx --conditions=react-server scripts/requeue-failed-audits.ts [--apply]
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

async function main() {
  const apply = process.argv.includes('--apply')
  const { prisma } = await import('../src/server/db/client')

  const dead = await prisma.queueJob.findMany({
    where: { queue: 'audit', state: 'DEAD' },
    select: { id: true, payload: true, lastError: true },
  })

  // Businesses the UI shows as in-flight but which have no live queue job —
  // the signature of a worker killed mid-audit.
  const inFlight = await prisma.business.findMany({
    where: { auditStatus: { in: ['RUNNING', 'QUEUED'] } },
    select: { id: true, workspaceId: true, name: true },
  })

  const live = await prisma.queueJob.findMany({
    where: { queue: 'audit', state: { in: ['WAITING', 'ACTIVE'] } },
    select: { payload: true },
  })
  const liveIds = new Set(
    live.map((j) => (j.payload as { businessId?: string })?.businessId).filter(Boolean),
  )
  const deadIds = new Set(
    dead.map((j) => (j.payload as { businessId?: string })?.businessId).filter(Boolean),
  )

  const orphaned = inFlight.filter((b) => !liveIds.has(b.id) && !deadIds.has(b.id))

  const errorCounts = new Map<string, number>()
  for (const j of dead) {
    const key = (j.lastError ?? 'unknown').split('\n')[0].slice(0, 80)
    errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1)
  }

  console.log('\n── Recovery plan ─────────────────────────────────────────────')
  console.log(`  dead audit jobs to requeue      ${dead.length}`)
  for (const [err, n] of errorCounts) console.log(`      ${String(n).padStart(3)} × ${err}`)
  console.log(`  orphaned in-flight businesses   ${orphaned.length}`)
  console.log(`  already queued / active         ${liveIds.size}`)

  if (!apply) {
    console.log('\n  Dry run. Re-run with --apply to execute.\n')
    await prisma.$disconnect()
    return
  }

  const requeued = await prisma.queueJob.updateMany({
    where: { queue: 'audit', state: 'DEAD' },
    data: { state: 'WAITING', attempts: 0, lastError: null, lockedAt: null, lockedBy: null, runAt: new Date() },
  })

  let enqueued = 0
  for (const b of orphaned) {
    await prisma.queueJob.create({
      data: {
        queue: 'audit',
        name: 'audit.site',
        payload: {
          businessId: b.id,
          workspaceId: b.workspaceId,
          depth: 'STANDARD',
          trigger: 'recheck',
        },
        maxAttempts: 3,
      },
    })
    enqueued++
  }

  // Reflect reality in the UI: these are queued, not running.
  await prisma.business.updateMany({
    where: { id: { in: [...deadIds, ...orphaned.map((b) => b.id)] as string[] } },
    data: { auditStatus: 'QUEUED' },
  })

  console.log(`\n  requeued dead jobs              ${requeued.count}`)
  console.log(`  enqueued orphaned businesses    ${enqueued}`)
  console.log('\n✅ Recovery applied — start the worker to process them\n')

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
