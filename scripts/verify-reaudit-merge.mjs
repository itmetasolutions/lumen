/**
 * Live regression check for §26 targeted re-audits.
 *
 * 1. Run a FULL audit on a business with a reachable website.
 * 2. Record its SEO projection.
 * 3. Run a UX-ONLY re-audit.
 * 4. Assert the SEO projection is untouched and the UX projection is refreshed.
 *
 * Before the fix, step 4 nulled seoHealth and dropped the business out of the
 * SEO tab despite nothing about its SEO having been re-examined.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const EMAIL = process.env.SEED_EMAIL ?? 'admin@lumen.local'
const PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe123!'

let cookie = ''

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  })
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  const text = await res.text()
  try {
    return { status: res.status, ok: res.ok, body: JSON.parse(text) }
  } catch {
    return { status: res.status, ok: res.ok, body: text }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const line = (l, v) => console.log(`  ${String(l).padEnd(30)} ${v}`)

async function fetchRow(id) {
  const res = await api('/api/leads', {
    method: 'POST',
    body: JSON.stringify({
      tab: 'all',
      filters: { logic: 'AND', conditions: [{ field: 'websiteStatus', op: 'eq', value: 'REACHABLE' }] },
      pageSize: 200,
    }),
  })
  return res.body.rows?.find((r) => r.id === id)
}

async function waitForAudit(id, label) {
  for (let i = 0; i < 90; i++) {
    await sleep(5000)
    const row = await fetchRow(id)
    process.stdout.write(`\r  ${label}: ${row?.auditStatus}   `)
    if (row && ['COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED'].includes(row.auditStatus)) {
      console.log('')
      return row
    }
  }
  throw new Error(`${label} never finished`)
}

async function main() {
  await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })

  const list = await api('/api/leads', {
    method: 'POST',
    body: JSON.stringify({
      tab: 'all',
      filters: { logic: 'AND', conditions: [{ field: 'websiteStatus', op: 'eq', value: 'REACHABLE' }] },
      pageSize: 200,
    }),
  })
  const target = list.body.rows?.[0]
  if (!target) throw new Error('no business with a reachable website')

  console.log('\n── Target ────────────────────────────────────────────────────')
  line('business', target.name)
  line('website', target.websiteUrl)

  console.log('\n── 1. Full audit (baseline) ──────────────────────────────────')
  let r = await api(`/api/businesses/${target.id}/reaudit`, {
    method: 'POST',
    body: JSON.stringify({ scopes: ['seo', 'technical', 'performance', 'ux'], depth: 'STANDARD' }),
  })
  if (!r.ok) throw new Error(`reaudit failed: ${JSON.stringify(r.body)}`)
  const before = await waitForAudit(target.id, 'full audit')

  line('seoHealth', before.seoHealth)
  line('seoIssueCount', before.seoIssueCount)
  line('needsSeo', before.needsSeo)
  line('seoOpp', before.seoOpp)
  line('uxHealth', before.uxHealth)
  line('technicalHealth', before.technicalHealth)
  line('perfScoreMobile', before.perfScoreMobile ?? 'not measured')

  if (before.seoHealth === null) {
    throw new Error('baseline full audit produced no SEO score — cannot test the merge')
  }

  console.log('\n── 2. UX-only re-audit ───────────────────────────────────────')
  r = await api(`/api/businesses/${target.id}/reaudit`, {
    method: 'POST',
    body: JSON.stringify({ scopes: ['ux'], depth: 'STANDARD' }),
  })
  if (!r.ok) throw new Error(`reaudit failed: ${JSON.stringify(r.body)}`)
  const after = await waitForAudit(target.id, 'ux-only re-audit')

  line('seoHealth', after.seoHealth)
  line('seoIssueCount', after.seoIssueCount)
  line('needsSeo', after.needsSeo)
  line('seoOpp', after.seoOpp)
  line('uxHealth', after.uxHealth)
  line('technicalHealth', after.technicalHealth)

  console.log('\n── 3. Assertions ─────────────────────────────────────────────')
  const checks = [
    ['seoHealth preserved', after.seoHealth === before.seoHealth, `${before.seoHealth} → ${after.seoHealth}`],
    ['seoIssueCount preserved', after.seoIssueCount === before.seoIssueCount, `${before.seoIssueCount} → ${after.seoIssueCount}`],
    ['needsSeo preserved', after.needsSeo === before.needsSeo, `${before.needsSeo} → ${after.needsSeo}`],
    ['seoOpp preserved', after.seoOpp === before.seoOpp, `${before.seoOpp} → ${after.seoOpp}`],
    ['technicalHealth preserved', after.technicalHealth === before.technicalHealth, `${before.technicalHealth} → ${after.technicalHealth}`],
    ['uxHealth still present', after.uxHealth !== null, String(after.uxHealth)],
  ]

  let failed = 0
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${String(label).padEnd(28)} ${detail}`)
    if (!pass) failed++
  }

  // The SEO tab must still contain this business.
  const seoTab = await api('/api/leads', {
    method: 'POST',
    body: JSON.stringify({ tab: 'seo', pageSize: 200 }),
  })
  const inSeoTab = seoTab.body.rows?.some((x) => x.id === target.id)
  if (before.needsSeo) {
    const pass = inSeoTab === true
    console.log(`  ${pass ? '✓' : '✗'} ${'still in SEO tab'.padEnd(28)} ${inSeoTab}`)
    if (!pass) failed++
  }

  if (failed > 0) {
    console.log(`\n❌ ${failed} assertion(s) failed — targeted re-audit still clobbers other domains\n`)
    process.exit(1)
  }
  console.log('\n✅ Targeted re-audit preserved every domain it did not measure\n')
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
