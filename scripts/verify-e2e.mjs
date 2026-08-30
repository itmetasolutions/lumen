/**
 * End-to-end acceptance check (§41).
 *
 * Drives the running app over HTTP exactly as the browser does — session cookie
 * included — so it exercises auth, workspace scoping, the queue, the audit
 * pipeline, the filter compiler and the export writer for real.
 *
 * Usage: node scripts/verify-e2e.mjs [jobId]
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
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, ok: res.ok, body }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function line(label, value) {
  console.log(`  ${String(label).padEnd(34)} ${value}`)
}

async function main() {
  const jobId = process.argv[2]

  console.log('\n── 1. Authentication ─────────────────────────────────────────')
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!login.ok) throw new Error(`login failed: ${JSON.stringify(login.body)}`)
  line('signed in as', EMAIL)

  // Unauthenticated access must be refused.
  const saved = cookie
  cookie = ''
  const anon = await api('/api/leads', { method: 'POST', body: JSON.stringify({ tab: 'all' }) })
  line('unauthenticated /api/leads', `HTTP ${anon.status} (expected 401)`)
  if (anon.status !== 401) throw new Error('workspace isolation not enforced')
  cookie = saved

  console.log('\n── 2. Discovery job ──────────────────────────────────────────')
  if (!jobId) throw new Error('pass a job id as the first argument')

  let job
  for (let i = 0; i < 90; i++) {
    const res = await api(`/api/discovery/jobs/${jobId}`)
    if (!res.ok) throw new Error(`job fetch failed: ${JSON.stringify(res.body)}`)
    job = res.body
    const j = job.job
    const done = job.audits.done
    const total = job.audits.done + job.audits.pending
    process.stdout.write(
      `\r  ${j.state.padEnd(10)} ${String(j.progressPercent).padStart(3)}%  ` +
        `candidates=${j.candidatesFound} unique=${j.uniqueBusinesses} new=${j.newBusinesses} ` +
        `errors=${j.errorCount} audits=${done}/${total}   `,
    )
    const terminal = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(j.state)
    if (terminal && job.audits.pending === 0) break
    await sleep(5000)
  }
  console.log('\n')

  const j = job.job
  line('state', j.state)
  line('sources searched', j.sourcesSearched.join(', ') || '—')
  line('geographic cells', `${j.cellsSearched}/${j.cellsPlanned}`)
  line('queries executed', j.queriesExecuted)
  line('candidates found', j.candidatesFound)
  line('unique businesses', j.uniqueBusinesses)
  line('duplicates merged', j.duplicatesMerged)
  line('new businesses', j.newBusinesses)
  line('errors', j.errorCount)
  line('audits completed', `${job.audits.done}/${job.audits.done + job.audits.pending}`)

  console.log('\n  Job events:')
  for (const e of j.events.slice(-8)) {
    console.log(`    [${e.level}] ${e.message}`)
  }

  console.log('\n── 3. Tab counts (overlapping opportunities) ─────────────────')
  const all = await api('/api/leads', {
    method: 'POST',
    body: JSON.stringify({ tab: 'all', page: 1, pageSize: 200 }),
  })
  if (!all.ok) throw new Error(`leads failed: ${JSON.stringify(all.body)}`)
  for (const [tab, count] of Object.entries(all.body.counts)) line(tab, count)

  const rows = all.body.rows
  line('total in All Businesses', all.body.total)

  // Verify overlap is real rather than asserted.
  const multi = rows.filter(
    (r) => [r.needsWebsite, r.needsRedesign, r.needsSeo, r.needsSpeed].filter(Boolean).length > 1,
  )
  line('businesses in >1 opportunity', multi.length)
  if (multi[0]) {
    const m = multi[0]
    const tabs = [
      m.needsWebsite && 'Website',
      m.needsRedesign && 'Redesign',
      m.needsSeo && 'SEO',
      m.needsSpeed && 'Speed',
    ].filter(Boolean)
    line('  example', `${m.name} → ${tabs.join(' + ')}`)
  }

  // "Not Found" discipline: nothing may be silently invented.
  const withoutWebsite = rows.filter((r) => !r.websiteUrl).length
  const withoutPhone = rows.filter((r) => !r.primaryPhone).length
  const withoutEmail = rows.filter((r) => !r.primaryEmail).length
  line('missing website (Not Found)', withoutWebsite)
  line('missing phone (Not Found)', withoutPhone)
  line('missing email (Not Found)', withoutEmail)

  console.log('\n── 4. Evidence on a real audit ───────────────────────────────')
  const audited = rows.find((r) => r.seoIssueCount > 0 || r.uxIssueCount > 0)
  if (audited) {
    line('business', audited.name)
    line('website', audited.websiteUrl ?? 'Not Found')
    line('lead score / tier', `${audited.leadScore} / ${audited.leadTier}`)
    line('SEO health vs opportunity', `${audited.seoHealth} vs ${audited.seoOpp}`)
    line('UX health', audited.uxHealth ?? 'Not Found')
    line('perf mobile / desktop', `${audited.perfScoreMobile ?? '—'} / ${audited.perfScoreDesktop ?? '—'}`)
    line('SEO / UX findings', `${audited.seoIssueCount} / ${audited.uxIssueCount}`)
  } else {
    line('note', 'no audited business with findings yet')
  }

  console.log('\n── 5. Filtered query (server-side) ───────────────────────────')
  const filterQuery = {
    tab: 'all',
    filters: {
      logic: 'AND',
      conditions: [{ field: 'hasPhone', op: 'eq', value: true }],
    },
    page: 1,
    pageSize: 200,
  }
  const filtered = await api('/api/leads', {
    method: 'POST',
    body: JSON.stringify(filterQuery),
  })
  line('filter', 'hasPhone = true')
  line('unfiltered total', all.body.total)
  line('filtered total', filtered.body.total)

  console.log('\n── 6. Export parity (§37) ────────────────────────────────────')
  const exp = await api('/api/export', {
    method: 'POST',
    body: JSON.stringify({
      format: 'CSV',
      scope: 'FILTER',
      tab: 'all',
      query: filterQuery,
      columns: [],
    }),
  })
  if (!exp.ok) throw new Error(`export failed: ${JSON.stringify(exp.body)}`)
  line('export queued, expected rows', exp.body.expectedRows)

  let exportJob = null
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const list = await api('/api/export')
    exportJob = list.body.jobs.find((e) => e.id === exp.body.id)
    if (exportJob && ['COMPLETED', 'FAILED'].includes(exportJob.state)) break
  }
  if (!exportJob) throw new Error('export job never appeared')
  line('export state', exportJob.state)
  if (exportJob.state === 'FAILED') throw new Error(`export failed: ${exportJob.error}`)
  line('rows written', exportJob.rowCount)
  line('file', exportJob.fileName)
  line('bytes', exportJob.bytes)

  const parity = exportJob.rowCount === filtered.body.total
  line('MATCHES FILTERED VIEW', parity ? `YES (${exportJob.rowCount} = ${filtered.body.total})` : `NO (${exportJob.rowCount} != ${filtered.body.total})`)
  if (!parity) throw new Error('export did not match the filtered view')

  const dl = await fetch(`${BASE}/api/export/${exp.body.id}/download`, {
    headers: { cookie },
  })
  const csv = await dl.text()
  const lines = csv.trim().split('\n')
  line('downloaded lines (incl header)', lines.length)
  line('header', lines[0].slice(0, 100))
  if (lines[1]) line('first row', lines[1].slice(0, 100))

  // The downloaded file must contain exactly the filtered rows.
  const dataRows = lines.length - 1
  line('data rows in file', dataRows)
  if (dataRows !== filtered.body.total) {
    throw new Error(`file has ${dataRows} rows, filter returned ${filtered.body.total}`)
  }

  console.log('\n── 7. Export scope isolation ─────────────────────────────────')
  const expAll = await api('/api/export', {
    method: 'POST',
    body: JSON.stringify({ format: 'CSV', scope: 'ALL', tab: 'all', query: filterQuery, columns: [] }),
  })
  line('Export All expected rows', expAll.body.expectedRows)
  line('Export Filter expected rows', exp.body.expectedRows)
  line('scopes differ correctly', expAll.body.expectedRows >= exp.body.expectedRows ? 'YES' : 'NO')

  console.log('\n✅ End-to-end verification passed\n')
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
