/**
 * Targeted re-audit check for the UX stage.
 *
 * Picks a business with a reachable website, queues a UX-only re-audit and
 * reports the stage outcome plus the measurements it produced.
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
const line = (l, v) => console.log(`  ${String(l).padEnd(32)} ${v}`)

async function main() {
  await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })

  const leads = await api('/api/leads', {
    method: 'POST',
    body: JSON.stringify({
      tab: 'all',
      filters: {
        logic: 'AND',
        conditions: [{ field: 'websiteStatus', op: 'eq', value: 'REACHABLE' }],
      },
      pageSize: 5,
    }),
  })

  const target = leads.body.rows?.[0]
  if (!target) throw new Error('no business with a reachable website')

  console.log('\n── UX re-audit ───────────────────────────────────────────────')
  line('business', target.name)
  line('website', target.websiteUrl)

  const queued = await api(`/api/businesses/${target.id}/reaudit`, {
    method: 'POST',
    body: JSON.stringify({ scopes: ['ux'], depth: 'STANDARD' }),
  })
  if (!queued.ok) throw new Error(`reaudit failed: ${JSON.stringify(queued.body)}`)
  line('queued', 'yes')

  // Poll the profile page data via the leads API until the audit lands.
  let result = null
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const res = await api('/api/leads', {
      method: 'POST',
      body: JSON.stringify({
        tab: 'all',
        filters: { logic: 'AND', conditions: [{ field: 'name', op: 'eq', value: target.name }] },
        pageSize: 1,
      }),
    })
    const row = res.body.rows?.[0]
    process.stdout.write(`\r  polling… auditStatus=${row?.auditStatus} uxHealth=${row?.uxHealth ?? '—'}   `)
    if (row && ['COMPLETED', 'PARTIAL', 'FAILED'].includes(row.auditStatus)) {
      result = row
      break
    }
  }
  console.log('\n')

  if (!result) throw new Error('audit never completed')

  line('audit status', result.auditStatus)
  line('UX health', result.uxHealth ?? 'Not Found')
  line('UX findings', result.uxIssueCount)
  line('redesign opportunity', result.redesignOpp ?? 'Not Found')
  line('needsRedesign', result.needsRedesign)
  line('lead score', result.leadScore)

  if (result.uxHealth === null) {
    console.log('\n❌ UX stage still produced no measurement\n')
    process.exit(1)
  }
  console.log('\n✅ UX stage produced measurements\n')
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
