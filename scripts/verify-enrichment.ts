/**
 * Live check that bulk contact enrichment is bounded and converges.
 *
 * Runs the same function the API route calls, twice, and asserts:
 *   - each call returns inside its time budget (so it fits in an HTTP request)
 *   - `remaining` never increases, so a client looping on it terminates
 *   - businesses attempted are marked, whether or not contacts were found
 *
 * Run: npx tsx --conditions=react-server scripts/verify-enrichment.ts
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

const line = (l: string, v: unknown) => console.log(`  ${l.padEnd(30)} ${String(v)}`)

async function main() {
  const { prisma } = await import('../src/server/db/client')
  const { enrichMissingContacts } = await import('../src/server/leads/contact-enrichment')

  const ws = await prisma.workspace.findFirst({
    where: { businesses: { some: { hasWebsite: true } } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  })
  if (!ws) throw new Error('no workspace with websites')

  console.log('\n── Workspace ─────────────────────────────────────────────────')
  line('name', ws.name)

  const candidates = await prisma.business.count({
    where: {
      workspaceId: ws.id,
      hasWebsite: true,
      websiteUrl: { not: null },
      OR: [{ hasPhone: false }, { hasEmail: false }, { hasSocial: false }],
    },
  })
  line('missing some contact detail', candidates)

  if (candidates === 0) {
    console.log('\n  Nothing to enrich — every business already has full contacts.\n')
    await prisma.$disconnect()
    return
  }

  let failed = 0
  let previousRemaining = Number.POSITIVE_INFINITY

  for (const pass of [1, 2]) {
    console.log(`\n── Pass ${pass} ───────────────────────────────────────────────────`)
    const started = Date.now()
    const result = await enrichMissingContacts({
      workspaceId: ws.id,
      limit: 25,
      deadlineMs: 40_000,
    })
    const elapsed = Date.now() - started

    line('elapsed', `${(elapsed / 1000).toFixed(1)}s`)
    line('processed', result.processed)
    line('updated', result.updated)
    line('contacts added', result.contactsAdded)
    line('errors', result.errors.length)
    line('stoppedEarly (hit budget)', result.stoppedEarly)
    line('remaining', result.remaining)

    // The whole point of the change: a call must fit inside an HTTP request.
    const inBudget = elapsed < 60_000
    console.log(`  ${inBudget ? '✓' : '✗'} ${'returned within 60s'.padEnd(28)} ${(elapsed / 1000).toFixed(1)}s`)
    if (!inBudget) failed++

    const converging = result.remaining <= previousRemaining
    console.log(`  ${converging ? '✓' : '✗'} ${'remaining did not grow'.padEnd(28)} ${previousRemaining === Infinity ? '—' : previousRemaining} → ${result.remaining}`)
    if (!converging) failed++
    previousRemaining = result.remaining

    if (result.remaining === 0) break
  }

  const attempted = await prisma.business.count({
    where: { workspaceId: ws.id, contactsEnrichedAt: { not: null } },
  })
  console.log('')
  line('marked as attempted', attempted)
  const marked = attempted > 0
  console.log(`  ${marked ? '✓' : '✗'} ${'attempts recorded'.padEnd(28)} ${attempted}`)
  if (!marked) failed++

  await prisma.$disconnect()

  if (failed > 0) {
    console.log(`\n❌ ${failed} assertion(s) failed\n`)
    process.exit(1)
  }
  console.log('\n✅ Enrichment is bounded and converges\n')
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
