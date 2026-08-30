/**
 * Round-trip check: export leads from one workspace, import them into another.
 *
 * This is the whole feature in one test. It asserts the three properties that
 * matter: the data arrives, re-importing the same file merges instead of
 * duplicating, and audit scores from the source workspace do not come along.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-import.ts
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

const line = (l: string, v: unknown) => console.log(`  ${l.padEnd(30)} ${String(v)}`)

const ctx = {
  jobId: 'verify',
  attempt: 1,
  heartbeat: async () => {},
  isCancelled: async () => false,
  log: () => {},
}

async function main() {
  const { prisma } = await import('../src/server/db/client')
  const { EXPORT_INCLUDE, resolveColumns, cellValue } = await import('../src/server/export/columns')
  const { runImport } = await import('../src/server/import/run')
  const { getStorage } = await import('../src/server/storage')

  const workspaces = await prisma.workspace.findMany({
    select: { id: true, name: true, _count: { select: { businesses: true } } },
    orderBy: { createdAt: 'asc' },
  })
  // Import into the seed workspace, never into real data.
  const target = workspaces.find((w) => w.name === 'My Workspace')
  const source = workspaces.find((w) => w.id !== target?.id && w._count.businesses > 20)

  if (!source || !target) throw new Error('need two workspaces, one with data')

  console.log('\n── Workspaces ────────────────────────────────────────────────')
  line('source', `${source.name} (${source._count.businesses} businesses)`)
  line('target', `${target.name} (${target._count.businesses} businesses)`)

  // ── 1. Export a slice, using the real export column registry ───────────────
  const rows = await prisma.business.findMany({
    where: { workspaceId: source.id },
    include: EXPORT_INCLUDE,
    take: 25,
    orderBy: { leadScore: 'desc' },
  })

  const columns = resolveColumns([])
  const csv = [
    columns.map((c) => quote(c.label)).join(','),
    ...rows.map((r) => columns.map((c) => quote(String(cellValue(c, r)))).join(',')),
  ].join('\n')

  console.log('\n── 1. Export ─────────────────────────────────────────────────')
  line('rows exported', rows.length)
  line('columns', columns.length)
  line('includes score columns', columns.some((c) => c.id === 'leadScore'))

  // ── 2. Import into the other workspace ─────────────────────────────────────
  const storage = await getStorage()
  const key = `imports/_verify/${Date.now()}.csv`
  await storage.put(key, Buffer.from(csv, 'utf8'), 'text/csv')

  const targetBefore = await prisma.business.count({ where: { workspaceId: target.id } })

  const job1 = await prisma.importJob.create({
    data: {
      workspaceId: target.id,
      fileName: 'verify.csv',
      filePath: key,
      format: 'CSV',
      state: 'PENDING',
    },
    select: { id: true },
  })

  console.log('\n── 2. First import ───────────────────────────────────────────')
  await runImport({ importJobId: job1.id, workspaceId: target.id }, ctx)
  const r1 = await prisma.importJob.findUniqueOrThrow({ where: { id: job1.id } })

  line('state', r1.state)
  line('created', r1.createdCount)
  line('merged', r1.mergedCount)
  line('skipped', r1.skippedCount)

  const targetAfter1 = await prisma.business.count({ where: { workspaceId: target.id } })
  line('target grew by', targetAfter1 - targetBefore)

  let failed = 0
  if (r1.createdCount === 0) {
    console.log('  ✗ nothing was imported')
    failed++
  } else {
    console.log('  ✓ leads arrived in the target workspace')
  }

  // ── 3. Re-import the same file — must merge, not duplicate ─────────────────
  const job2 = await prisma.importJob.create({
    data: {
      workspaceId: target.id,
      fileName: 'verify.csv',
      filePath: key,
      format: 'CSV',
      state: 'PENDING',
    },
    select: { id: true },
  })

  console.log('\n── 3. Re-import the identical file ───────────────────────────')
  await runImport({ importJobId: job2.id, workspaceId: target.id }, ctx)
  const r2 = await prisma.importJob.findUniqueOrThrow({ where: { id: job2.id } })

  line('created', r2.createdCount)
  line('merged', r2.mergedCount)

  const targetAfter2 = await prisma.business.count({ where: { workspaceId: target.id } })
  line('target grew by', targetAfter2 - targetAfter1)

  if (targetAfter2 === targetAfter1 && r2.mergedCount > 0) {
    console.log('  ✓ re-import merged into existing records — no duplicates')
  } else {
    console.log(`  ✗ re-import created ${targetAfter2 - targetAfter1} duplicate(s)`)
    failed++
  }

  // ── 4. Audit scores must not travel between workspaces ─────────────────────
  console.log('\n── 4. Audit results stay behind ──────────────────────────────')
  const imported = await prisma.business.findMany({
    where: { workspaceId: target.id, sources: { some: { provider: 'csv-import' } } },
    select: {
      name: true, leadScore: true, seoHealth: true, needsSeo: true,
      primaryPhone: true, city: true, rating: true, auditStatus: true,
    },
    take: 5,
  })

  const anyScores = imported.some((b) => b.leadScore !== null || b.seoHealth !== null)
  line('imported sample', imported.length)
  line('any carry a lead/SEO score', anyScores)

  if (anyScores) {
    console.log("  ✗ audit scores were imported from the source workspace")
    failed++
  } else {
    console.log('  ✓ scores are absent — they will be computed by this workspace')
  }

  // Fidelity, not presence: the number of imported rows carrying a phone must
  // equal the number the source actually had. Sampling a few rows proves nothing
  // when the source data is sparse.
  const sourcePhones = rows.filter((r) => r.primaryPhone).length
  const sourceCities = rows.filter((r) => r.city).length

  const allImported = await prisma.business.findMany({
    where: { workspaceId: target.id, sources: { some: { provider: 'csv-import' } } },
    select: { primaryPhone: true, city: true },
  })
  const importedPhones = allImported.filter((b) => b.primaryPhone).length
  const importedCities = allImported.filter((b) => b.city).length

  line('phones  source → imported', `${sourcePhones} → ${importedPhones}`)
  line('cities  source → imported', `${sourceCities} → ${importedCities}`)

  if (importedPhones === sourcePhones && importedCities === sourceCities) {
    console.log('  ✓ every fact present in the source arrived intact')
  } else {
    console.log('  ✗ facts were lost in the round trip')
    failed++
  }

  // The formula guard must not survive into stored values.
  const guarded = allImported.filter((b) => b.primaryPhone?.startsWith("'")).length
  console.log(`  ${guarded === 0 ? '✓' : '✗'} no phone carries the CSV formula guard (${guarded} found)`)
  if (guarded > 0) failed++

  if (imported[0]) {
    console.log('\n  Sample imported lead:')
    console.log(`    ${imported[0].name}`)
    console.log(`    phone ${imported[0].primaryPhone ?? 'Not Found'} · city ${imported[0].city ?? 'Not Found'} · rating ${imported[0].rating ?? 'Not Found'}`)
    console.log(`    leadScore ${imported[0].leadScore ?? 'null'} · auditStatus ${imported[0].auditStatus}`)
  }

  await storage.delete(key).catch(() => {})

  // Leave no trace: remove the records this verification created.
  const created = await prisma.business.findMany({
    where: {
      workspaceId: target.id,
      sources: { some: { provider: 'csv-import' } },
    },
    select: { id: true, sources: { select: { provider: true } } },
  })
  const onlyImport = created.filter((b) => b.sources.every((s) => s.provider === 'csv-import'))
  const removed = await prisma.business.deleteMany({
    where: { id: { in: onlyImport.map((b) => b.id) } },
  })
  console.log(`
  cleaned up ${removed.count} verification record(s)`)

  await prisma.$disconnect()

  if (failed > 0) {
    console.log(`\n❌ ${failed} check(s) failed\n`)
    process.exit(1)
  }
  console.log('\n✅ Round trip works: export → import, merging correctly\n')
}

function quote(v: string): string {
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
