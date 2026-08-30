/**
 * Worker entrypoint — `npm run worker`.
 *
 * Runs in its own process so that discovery and audits never occupy a request
 * thread (§17). Every queue is served concurrently by one process here; in
 * production each queue can be run as its own deployment by passing
 * `--queues=audit`.
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

async function main() {
  // Imported after env is loaded so the modules see DATABASE_URL etc.
  const { getQueue } = await import('../src/server/queue')
  const { runDiscovery } = await import('../src/server/discovery/run')
  const { runAudit } = await import('../src/server/audit/run')
  const { runExportJob } = await import('../src/server/export/run')
  const { runImport } = await import('../src/server/import/run')
  const { env } = await import('../src/server/env')

  const requested = process.argv
    .find((a) => a.startsWith('--queues='))
    ?.split('=')[1]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const queue = getQueue()

  const handlers = {
    'discovery.run': runDiscovery,
    'audit.site': runAudit,
    'export.run': runExportJob,
    'import.run': runImport,
  } as const

  const plan: Array<{ name: string; concurrency: number }> = [
    { name: 'discovery', concurrency: env.concurrencyDiscovery },
    { name: 'audit', concurrency: env.concurrencyAudit },
    { name: 'export', concurrency: 2 },
  ].filter((q) => !requested || requested.includes(q.name))

  if (plan.length === 0) {
    console.error(`No known queues matched --queues=${requested?.join(',')}`)
    process.exit(1)
  }

  console.log(
    `[worker] driver=${queue.driver} queues=${plan.map((p) => `${p.name}x${p.concurrency}`).join(' ')}`,
  )

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[worker] ${signal} received — finishing in-flight jobs`)
    await queue.stop()
    // In-flight handlers are allowed to complete; the visibility timeout
    // reclaims anything that does not.
    setTimeout(() => process.exit(0), 5_000).unref()
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  process.on('unhandledRejection', (reason) => {
    // A rejected promise inside a stage must not take the worker down —
    // that would stall every other queued job.
    console.error('[worker] unhandled rejection', reason)
  })

  await Promise.all(
    plan.map((q) =>
      queue.work(q.name, q.concurrency, handlers).catch((err) => {
        console.error(`[worker] queue "${q.name}" stopped:`, err)
      }),
    ),
  )
}

main().catch((err) => {
  console.error('[worker] fatal', err)
  process.exit(1)
})
