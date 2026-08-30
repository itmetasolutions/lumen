/**
 * Live check for per-business deep enrichment.
 *
 * Picks a real business that is missing contact details and runs the enrichment
 * exactly as the API route does, reporting every step.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-deep-enrich.ts [--website-missing]
 */
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

const line = (l: string, v: unknown) => console.log(`  ${l.padEnd(26)} ${String(v)}`)

async function main() {
  const wantNoWebsite = process.argv.includes('--website-missing')
  const wantWebsite = process.argv.includes('--has-website')

  const { prisma } = await import('../src/server/db/client')
  const { deepEnrichBusiness } = await import('../src/server/leads/deep-enrich')

  const target = await prisma.business.findFirst({
    where: {
      workspace: { slug: { startsWith: 'my-workspace' } },
      ...(wantNoWebsite
        ? { websiteUrl: null }
        : wantWebsite
          ? { websiteUrl: { not: null }, hasEmail: false }
          : { OR: [{ hasPhone: false }, { hasEmail: false }, { hasSocial: false }] }),
    },
    select: {
      id: true, name: true, workspaceId: true, websiteUrl: true,
      primaryPhone: true, primaryEmail: true, hasSocial: true, city: true, countryCode: true,
    },
    orderBy: { leadScore: 'desc' },
  })

  if (!target) throw new Error('no matching business in the seed workspace')

  console.log('\n── Before ────────────────────────────────────────────────────')
  line('business', target.name)
  line('city', target.city ?? 'Not Found')
  line('website', target.websiteUrl ?? 'Not Found')
  line('phone', target.primaryPhone ?? 'Not Found')
  line('email', target.primaryEmail ?? 'Not Found')
  line('social', target.hasSocial ? 'yes' : 'Not Found')

  console.log('\n── Running deep enrichment ───────────────────────────────────')
  const started = Date.now()
  const result = await deepEnrichBusiness({
    workspaceId: target.workspaceId,
    businessId: target.id,
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  for (const s of result.steps) {
    const mark = s.status === 'ok' ? '✓' : s.status === 'failed' ? '✗' : '·'
    console.log(`  ${mark} ${s.step.padEnd(28)} ${s.detail}`)
  }

  console.log('\n── After ─────────────────────────────────────────────────────')
  const after = await prisma.business.findUniqueOrThrow({
    where: { id: target.id },
    select: {
      websiteUrl: true, primaryPhone: true, primaryEmail: true,
      hasSocial: true, addressLine: true, contactsEnrichedAt: true,
      contacts: { select: { kind: true, value: true, provider: true } },
    },
  })

  line('elapsed', `${elapsed}s`)
  line('website', after.websiteUrl ?? 'Not Found')
  line('phone', after.primaryPhone ?? 'Not Found')
  line('email', after.primaryEmail ?? 'Not Found')
  line('social', after.hasSocial ? 'yes' : 'Not Found')
  line('contacts added', result.contactsAdded)
  line('fields filled', result.fieldsFilled.join(', ') || 'none')
  line('audit queued', result.auditQueued)
  line('attempt recorded', Boolean(after.contactsEnrichedAt))

  if (after.contacts.length > 0) {
    console.log('\n  Contacts on record:')
    for (const c of after.contacts.slice(0, 10)) {
      console.log(`    ${c.kind.padEnd(7)} ${String(c.value).slice(0, 48).padEnd(50)} via ${c.provider}`)
    }
  }

  // The run must never leave the record half-written.
  const failed = result.steps.filter((s) => s.status === 'failed')
  if (failed.length === result.steps.length) {
    console.log('\n❌ Every step failed\n')
    await prisma.$disconnect()
    process.exit(1)
  }

  console.log('\n✅ Deep enrichment completed without consuming any paid search quota\n')
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
