/**
 * Live regression check for §26 targeted re-audits, driven directly against the
 * audit pipeline (no HTTP, no credentials).
 *
 * 1. Full audit  → record the SEO / technical projection.
 * 2. UX-only audit → assert those projections are untouched and UX is refreshed.
 *
 * Before the fix, step 2 nulled seoHealth and cleared needsSeo, silently
 * dropping the business out of the SEO tab.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-merge-direct.ts
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

interface Row {
  seoHealth: number | null
  seoOpp: number | null
  seoIssueCount: number
  needsSeo: boolean
  technicalHealth: number | null
  uxHealth: number | null
  uxIssueCount: number
  seoMissingTitle: boolean
  seoNoSitemap: boolean
  techNoHttps: boolean
  leadScore: number | null
}

const SELECT = {
  seoHealth: true,
  seoOpp: true,
  seoIssueCount: true,
  needsSeo: true,
  technicalHealth: true,
  uxHealth: true,
  uxIssueCount: true,
  seoMissingTitle: true,
  seoNoSitemap: true,
  techNoHttps: true,
  leadScore: true,
} as const

function line(l: string, v: unknown) {
  console.log(`  ${l.padEnd(28)} ${String(v)}`)
}

async function main() {
  const { prisma } = await import('../src/server/db/client')
  const { runAudit } = await import('../src/server/audit/run')

  // A no-op job context: this script is the "worker" for these two runs.
  const ctx = {
    jobId: 'verify',
    attempt: 1,
    heartbeat: async () => {},
    isCancelled: async () => false,
    log: () => {},
  }

  const target = await prisma.business.findFirst({
    where: { websiteStatus: 'REACHABLE', workspace: { slug: { startsWith: 'my-workspace' } } },
    select: { id: true, name: true, websiteUrl: true, workspaceId: true },
  })

  if (!target) throw new Error('no reachable business in the seed workspace')

  console.log('\n── Target ────────────────────────────────────────────────────')
  line('business', target.name)
  line('website', target.websiteUrl)

  console.log('\n── 1. Full audit (baseline) ──────────────────────────────────')
  await runAudit(
    {
      businessId: target.id,
      workspaceId: target.workspaceId,
      depth: 'STANDARD',
      trigger: 'manual',
      scopes: ['crawl', 'technical', 'seo', 'ux'],
    },
    ctx,
  )

  const before = (await prisma.business.findUnique({
    where: { id: target.id },
    select: SELECT,
  })) as Row

  for (const [k, v] of Object.entries(before)) line(k, v)

  if (before.seoHealth === null) {
    throw new Error('baseline audit produced no SEO score — cannot test the merge')
  }

  console.log('\n── 2. UX-only re-audit ───────────────────────────────────────')
  await runAudit(
    {
      businessId: target.id,
      workspaceId: target.workspaceId,
      depth: 'STANDARD',
      trigger: 'manual',
      scopes: ['ux'],
    },
    ctx,
  )

  const after = (await prisma.business.findUnique({
    where: { id: target.id },
    select: SELECT,
  })) as Row

  for (const [k, v] of Object.entries(after)) line(k, v)

  console.log('\n── 3. Assertions ─────────────────────────────────────────────')
  const checks: Array<[string, boolean, string]> = [
    ['seoHealth preserved', after.seoHealth === before.seoHealth, `${before.seoHealth} → ${after.seoHealth}`],
    ['seoOpp preserved', after.seoOpp === before.seoOpp, `${before.seoOpp} → ${after.seoOpp}`],
    ['seoIssueCount preserved', after.seoIssueCount === before.seoIssueCount, `${before.seoIssueCount} → ${after.seoIssueCount}`],
    ['needsSeo preserved', after.needsSeo === before.needsSeo, `${before.needsSeo} → ${after.needsSeo}`],
    ['seoMissingTitle preserved', after.seoMissingTitle === before.seoMissingTitle, `${before.seoMissingTitle} → ${after.seoMissingTitle}`],
    ['seoNoSitemap preserved', after.seoNoSitemap === before.seoNoSitemap, `${before.seoNoSitemap} → ${after.seoNoSitemap}`],
    ['technicalHealth preserved', after.technicalHealth === before.technicalHealth, `${before.technicalHealth} → ${after.technicalHealth}`],
    ['techNoHttps preserved', after.techNoHttps === before.techNoHttps, `${before.techNoHttps} → ${after.techNoHttps}`],
    ['uxHealth present', after.uxHealth !== null, String(after.uxHealth)],
  ]

  let failed = 0
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label.padEnd(28)} ${detail}`)
    if (!pass) failed++
  }

  // The audit history must show two rows, the second with SEO skipped.
  const audits = await prisma.audit.findMany({
    where: { businessId: target.id },
    orderBy: { startedAt: 'desc' },
    take: 2,
    select: { startedAt: true, status: true, seoStatus: true, uxStatus: true, seoHealth: true, uxHealth: true },
  })
  console.log('\n  Audit history (append-only):')
  for (const a of audits) {
    console.log(
      `    ${a.startedAt.toISOString()}  ${a.status.padEnd(9)} seo=${a.seoStatus.padEnd(7)} ux=${a.uxStatus.padEnd(7)} seoHealth=${a.seoHealth} uxHealth=${a.uxHealth}`,
    )
  }
  const historyOk = audits.length === 2 && audits[0].seoStatus === 'SKIPPED' && audits[1].seoHealth !== null
  console.log(`  ${historyOk ? '✓' : '✗'} ${'history intact'.padEnd(28)} older audit still holds its SEO score`)
  if (!historyOk) failed++

  await prisma.$disconnect()

  if (failed > 0) {
    console.log(`\n❌ ${failed} assertion(s) failed\n`)
    process.exit(1)
  }
  console.log('\n✅ Targeted re-audit preserved every domain it did not measure\n')
}

main().catch(async (err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
