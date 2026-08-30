# Lumen

Business lead intelligence and website audit platform.

Discover businesses across multiple providers, resolve them into one record each,
audit their websites with reproducible evidence, detect overlapping sales
opportunities, and export exactly the leads you filtered.

Search a market — *"Roofing companies in Dallas"* — and get answers to: who has
no website, who needs a redesign, who has SEO problems, who is slow, who has
several of those at once, who is worth calling first, and what evidence supports
each of those claims.

Then hand those leads to a calling team and watch the work happen: assign
queues, log every call against a fixed outcome vocabulary, track shifts, and
read a daily report per agent that nobody had to write.

> Not a Google Maps scraper. Google Places is one adapter behind a provider
> interface, and OpenStreetMap works with no API key at all, so the product is
> useful with real data out of the box.

---

## Download

Lumen ships as two Windows apps. Install the first on the machine that will
hold your leads; install the second on each agent's machine.

| | For | Download |
|---|---|---|
| **Lumen** | You — discovery, audits, assigning work, reports | **[⬇ Download Lumen](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Setup.exe)** |
| **Lumen Agent** | Your callers — their queue and nothing else | **[⬇ Download Lumen Agent](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Agent-Setup.exe)** |

[![Latest release](https://img.shields.io/github/v/release/itmetasolutions/lumen?label=latest&style=flat-square)](https://github.com/itmetasolutions/lumen/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/itmetasolutions/lumen/total?style=flat-square)](https://github.com/itmetasolutions/lumen/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-blue?style=flat-square)](https://github.com/itmetasolutions/lumen/releases/latest)

Both links always serve the newest installer — neither needs updating when you
publish a new version. [All releases and changelogs](https://github.com/itmetasolutions/lumen/releases).

**Lumen** includes everything: it bundles its own PostgreSQL and background
worker, so there is no database to install and nothing to configure before first
launch. It runs offline apart from the discovery providers themselves.

**Lumen Agent** (97 MB) is a thin client with no database of its own — agents
and their supervisor have to be looking at the same leads. On first run it asks
once for the address of your Lumen, which you get from **Team → Show address for
agents…** in the main app. Do not hand it out before turning on **Team → Let my
team connect**; see [Running a team](#running-a-team).

> You only need Lumen Agent if you have people making calls. A one-person setup
> is just the first app.

**Requirements** — Windows 10 or 11, 64-bit for both. Lumen needs roughly 700 MB
on disk after install, and Microsoft Edge or Google Chrome present for UX audits
and screenshots (optional for everything else). Lumen Agent needs about 350 MB
and a network route to your Lumen — nothing else.

**Lumen's first launch takes a minute** while it initialises its local database.
The splash screen reports each step, so you can see it working. Lumen Agent
starts immediately — it has no database to build.

**Updates install themselves.** Both apps check on launch, download in the
background and offer to restart. They read separate update feeds from the same
release, so an agent is never offered the server build by mistake. Running jobs
survive a restart — they live in the database queue, not in memory.

> **Windows SmartScreen will warn you.** Neither installer is code-signed yet, so
> you will see *"Windows protected your PC"*. Click **More info → Run anyway**.
> Worth telling your agents before they hit it. Signing is on the roadmap; see
> [`docs/DESKTOP.md`](docs/DESKTOP.md).

---

## Building and running it yourself

### Desktop build

```bash
npm run desktop:dist
```

The installer lands in `release/` as `Lumen-Setup.exe`. Build, release and
troubleshooting notes: [`docs/DESKTOP.md`](docs/DESKTOP.md).

### Development

```bash
npm install
```

Copy `.env.example` to `.env` and set at minimum:

```
DATABASE_URL="postgresql://user:password@host:5432/lumen?schema=public"
AUTH_SECRET="a-long-random-string"
```

Create the schema and the first account:

```bash
npm run db:push && npm run db:seed
```

Run the app **and the worker** — separate processes on purpose, so discovery and
audits never occupy a request thread:

```bash
npm run dev
```

```bash
npm run worker
```

Sign in with the credentials the seed script printed, then go to
**Discovery → New Discovery**. Without the worker running, jobs stay queued — the
progress page says so rather than spinning.

---

## What works without any API keys

| Capability | Unkeyed? | Notes |
|---|---|---|
| Business discovery | **Yes** | OpenStreetMap / Overpass with Nominatim geocoding. ODbL attribution shown in the UI. |
| Website crawl + technical audit | **Yes** | Built-in fetcher with SSRF protection and robots compliance. |
| SEO audit | **Yes** | Deterministic rules over the crawled DOM. |
| UX audit + screenshots | **Yes**, with a browser | Drives installed Edge/Chrome via `playwright-core`. Set `PLAYWRIGHT_CHANNEL`. |
| Contact enrichment | **Yes** | Crawls the business's own site for phone, email, socials and schema.org data. |
| Finding a missing website | **Yes** | Verifies candidate domains against the live page. No search API. |
| Performance | **Yes**, low volume | PageSpeed Insights permits unkeyed calls at a strict daily quota. |
| Google Places discovery | No | Needs a Google Places key. |
| SerpApi discovery | No | One key enables the Google Maps, Yelp and Yandex engines. |
| AI-assisted UX commentary | No | Optional. Never affects any score. |

Credentials are stored per workspace in **Settings → Connections**.
**Settings → Integrations** probes every adapter live and reports Connected /
Not connected / Error with an actionable reason — a present-but-invalid key is
worse than a missing one, because it fails silently inside a job.

A provider without credentials is excluded from the source picker with its reason
shown. It is never silently swapped for another, and never faked.

---

## Discovery sources

| Provider | Key | Gives you |
|---|---|---|
| **OpenStreetMap** | none | Addresses, websites, phones, emails. No ratings. |
| **Google Places** | `GOOGLE_MAPS_API_KEY` | Ratings, review counts, phones, websites, opening status. |
| **Yelp Fusion** | free Yelp key | Yelp listings with website URL and price range. 500 calls/day free, separate from the SerpApi quota. |
| **SerpApi — Google Maps** | SerpApi key | Local listings with ratings and reviews. |
| **SerpApi — Yelp** | same key | Yelp listings, categories, ratings, price range. |
| **SerpApi — Yandex** | same key | Finds business websites local APIs miss. |

All three SerpApi engines share one monthly quota, capped locally at **250
searches** by default and cross-checked against SerpApi's own account balance.
When it runs out, those engines report exhausted with the renewal date and drop
out of the picker — they never fail silently mid-run. Raise the cap or swap the
key in **Settings → Connections**.

Large areas are split into overlapping geographic cells and each is searched
separately, because every place-search API caps results per query. Industry terms
expand into curated variations ("plumber" → plumbing company, emergency plumber,
drain service); your own wording is always searched first and expansions are
recorded separately in the coverage report.

---

## The lead workspace

Seven tabs over one master database, all server-side filtered and paginated:

**All Businesses · Website Creation · Website Redesign · SEO · Speed
Optimization · Hot Leads · New Leads**

Tabs **overlap by design**. `needsWebsite`, `needsRedesign`, `needsSeo` and
`needsSpeed` are independent flags, so one business appears in every tab it
qualifies for.

- **Composable filters** — AND/OR trees over 55 fields: location, category,
  rating, audit status, contact availability, every score, specific findings ("Missing H1",
  "No sitemap", "Broken mobile layout"), opportunity flags, dates, source and
  outreach stage.
- **Saved views** remember tab, filters, sort, columns and date range together.
- **Search** across name, domain, phone, email and address.
- **Bulk actions** — queue audits for everything unaudited, enrich missing
  contacts, delete leads with no contact route. The audit action states how many
  businesses it will process before you commit, and never double-queues work
  already in flight.
- **Find missing details** on any business — derives likely domains from the
  name and verifies each against the live page, crawls the confirmed site,
  reads its schema.org data, and matches Yelp Fusion. Uses **no paid search
  quota**, and reports where it looked when it finds nothing.
- **Export** to CSV or XLSX: everything, exactly the current filter, or just the
  rows you ticked, choosing from 51 available fields.
- **Import** a CSV or XLSX exported from another Lumen workspace. Rows run
  through the same entity resolution as discovery, so an overlapping file merges
  instead of duplicating. Audit results are deliberately left behind — they
  describe an audit that ran elsewhere, and this workspace computes its own.

Clicking a business opens the full profile: contact and provenance, website
status, every audit finding with its evidence, mobile and desktop performance,
screenshots at two viewports, the reason each opportunity triggered, audit
history over time, who the lead is assigned to, its full calling record, and a
lightweight outreach status with notes and tags. Phone numbers and emails are
click-to-copy, because that is what an agent actually does with them.

---

## Cold-calling CRM

Lumen ships as two applications over one database: the **admin app**, where
leads are found and work is handed out, and the **Lumen Agent** app, where the
calling happens.

### For the supervisor

- **Team** — accounts exist only because an admin created one. There is no
  sign-up page into an existing workspace. Creating someone issues a temporary
  password shown exactly once; they are forced to replace it at first sign-in.
  Accounts are *disabled*, never deleted, because their call history is what the
  reports are built from. Disabling someone returns their leads to the pool.
- **Assignment** — hand leads to an agent one at a time from the lead profile,
  in bulk from any filtered view, or automatically. Assigning "everything
  matching this filter" resolves through the same compiler the table uses, so it
  means exactly what is on screen. A lead marked do-not-call is never assigned to
  anyone by any route.
- **Live floor** — who is online, who is on shift, which lead each agent has
  open, calls and contact rate so far today, and a live feed of dispositions.
  Polls every five seconds and pauses when the tab is in the background.
- **Reports** — a stored snapshot per agent per day, so past numbers never drift.
  Contact rate and calls-per-hour render as *unknown* rather than zero when
  there is nothing to divide by.

### For the agent

- A queue, not a database. Ordering is the calling strategy and is not
  adjustable: overdue follow-ups, then due today, then never called by lead
  score, then everything worked but unscheduled.
- **Clock in / clock out**, with shift time and active time tracked separately.
  Active time accrues server-side from heartbeats and is capped, so a laptop
  left open overnight adds no work.
- **One disposition screen** per call: the number, the business, what to talk
  about, eleven outcomes, notes, and a follow-up that is *mandatory* for any
  outcome that promises one. Call records cannot be edited or deleted — a
  mistake is corrected with a new call and a note, the way a ledger is.
- Agents cannot run discovery, export, import, or see anyone else's leads.
  Those are server-side 403s, not hidden buttons.

### Automation

The worker ticks every five minutes and decides for itself what is due, so a
worker stopped for a day catches up rather than losing the day:

- Rolls each day up into reports after the workspace's reporting hour, in the
  workspace's own timezone.
- Writes yesterday's reports if nothing was running when the day ended.
- Closes shifts people forgot to clock out of, ending them at the last credited
  activity rather than at "now".
- Returns leads nobody has touched in *N* days to the pool — never one with a
  scheduled follow-up still ahead of it.
- Tops each agent back up to their target queue size, best leads first.

All of it is configured in **Settings → Calling**, and all of it is off by
default except the day-end roll-up.

---

## Running a team

The admin app binds to localhost by default, which is right for one person on
one machine. For a team, turn on **Team → Let my team connect**: the server
rebinds to the network on a fixed port and the menu gives you the address to
read out to your agents. They enter it once when they first open Lumen Agent.

Only do that on a network you trust. Anything that can reach the machine can
reach the sign-in page — an account you created is still required to see
anything, but the login form itself becomes reachable.

Larger teams should deploy the web app somewhere reachable instead and point the
agent installers at that hostname.

---

## Architecture

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
Next.js 15 (App Router, RSC)  →  services (src/server/*)  →  JobQueue driver  →  worker
                                          ↓                                        ↓
                                    PostgreSQL / Prisma  ←──────────────────────────
```

**Queue driver.** `QUEUE_DRIVER=pg` (default) uses Postgres with
`SELECT … FOR UPDATE SKIP LOCKED` — genuine at-least-once delivery, retries with
exponential backoff, visibility timeouts and dead-lettering, with no second
datastore to install. `QUEUE_DRIVER=bullmq` + `REDIS_URL` swaps in BullMQ.
Application code only ever sees the `JobQueue` interface.

### Pipeline

```
PLAN      location → geocode → geographic cells   ×   industry → expanded terms
DISCOVER  provider.search() per (cell × term × provider), rate-limited and budgeted
NORMALIZE provider payload → one internal entity (the only translation point)
RESOLVE   blocking keys → match scoring → merge or insert, provenance appended
DETECT    website present? reachable? social-only?
AUDIT     crawl → technical → SEO → performance → UX   (stages fail independently)
SCORE     health → opportunity → lead priority
CLASSIFY  Opportunity rows + denormalised flags for server-side filtering
```

---

## Design decisions worth knowing

**Health and opportunity are separate numbers.** SEO Health 28 means the site is
bad. SEO Opportunity 86 means there is a lot to sell. Computed separately, stored
separately, displayed separately.

**Nothing is fabricated.** Missing data is `NULL` and renders as `Not Found`.
Demo providers are not offered for discovery. Any legacy demo records stay
stamped `isDemo`, badged `DEMO DATA`, suppressed in lead ranking, and carry a
`DEMO DATA` column into every export.

**Every finding carries evidence.** An `AuditIssue` records the selector queried,
the value measured, the viewport used and the URL affected. AI commentary is
stored as `source = AI_ASSISTED`, capped at MEDIUM confidence, and excluded from
opportunity scoring entirely — it never drives a verdict.

**Lead priority is not "worst website first."** It weights contactability and
credibility alongside need, so a dreadful site belonging to an unreachable
business does not outrank a reachable, credible one. Every score keeps its
`reasons[]`, so the UI can always answer "why 91?".

**Targeted re-audits merge, they do not replace.** Re-running only the UX checks
updates the UX projection and leaves SEO, speed and technical exactly as the last
audit that measured them left it. Each run declares which domains it is
*authoritative* over; everything else carries forward, opportunity reasons
included. Without this a UX-only re-audit silently drops a business out of the
SEO tab.

**History is append-only.** A re-audit writes a new `Audit` row. The denormalised
score columns on `Business` are a rebuilt projection of the latest audit, never
hand-authored, existing only so 100k+ rows filter and sort in Postgres.

**One filter compiler.** The table, the tab counts and the export all call
`compileQuery`. That is what makes "Export Current Filter" provably return the
rows on screen — there is no second code path to drift out of sync.

**Scoring weights are data.** Every number influencing a score lives in
`ScoringProfile.weights` and is editable in Settings → Scoring.

---

## Security

- Session cookies (httpOnly, SameSite=Lax, signed JWT), bcrypt password hashing
- Workspace isolation re-checked against the membership table on every request
- zod on every route; the filter DSL is a field allowlist, not free-form SQL
- Per-IP rate limiting by route class
- Exports written server-side and served through an authorised handler
- API keys stay server-side and are never returned to the browser
- **SSRF protection on the crawler** — it consumes URLs from third-party APIs and
  user uploads: scheme and port allowlists, DNS resolved before connect,
  private / loopback / link-local / CGNAT / cloud-metadata ranges rejected on
  **every redirect hop**, redirect cap, response size cap, content-type allowlist
- CSV cells beginning `= + - @` are prefixed to defuse spreadsheet formula injection

---

## Compliance

- Official provider APIs and permitted public sources only
- The crawler identifies itself, honours robots.txt and rate-limits per host
- No CAPTCHA solving or bot-protection evasion of any kind
- Contact details collected only where the business publishes them publicly
- The application never sends outreach; contact status is recorded by hand

---

## Testing

```bash
npm test
```

```bash
npm run typecheck
```

**203 tests across 11 suites**, covering the logic where a silent regression would
be expensive:

| Suite | Covers |
|---|---|
| `normalize` | Phone, URL, name, address and geo normalisation |
| `resolution` | Entity resolution — merging duplicates without merging branches |
| `scoring` | Health vs opportunity, overlap, lead priority, configurable weights |
| `filters` | Filter DSL, field allowlist, and export/table parity |
| `seo-rules` | Deterministic SEO rules and their evidence |
| `discovery` | Term expansion, geographic tiling, provider normalisation |
| `contact-enrichment` | Contact extraction, including the rules against guessing |
| `audit-merge` | Targeted re-audits preserving domains they did not measure |
| `enrichment-sources` | Domain candidate generation and schema.org extraction |
| `import` | CSV parsing, header mapping and export→import round-trip fidelity |
| `ssrf` | Every private and reserved range the crawler must refuse |

---

## Project layout

```
prisma/schema.prisma     data model
electron/                desktop main process: DB lifecycle, servers, updater
  agent-main.ts          the agent app — a thin client, no database of its own
scripts/                 worker, seed, desktop build, verification scripts
src/app/                 routes (App Router) and API handlers
src/server/
  discovery/providers/   Google Places, OpenStreetMap, SerpApi adapters
  resolution/            entity resolution and merging
  crawler/               SSRF guard, safe fetch, robots, crawl
  audit/                 seo · performance · ux · technical + orchestrator
  scoring/               configurable weights, health, opportunity, lead score
  filters/               filter DSL and its Prisma compiler
  export/                column registry, CSV and XLSX writers
  leads/                 queries, tab counts, contact enrichment
  crm/                   outcomes, assignment, calls, shifts, reports, upkeep
src/components/          UI, data table, filter builder, charts
  crm/                   assignment, reports, live floor, click-to-copy
  agent/                 agent shell, queue, call workspace
tests/                   unit tests for the logic above
docs/ARCHITECTURE.md     full architecture write-up
docs/DESKTOP.md          desktop build and release guide
```

---

## Adding a discovery provider

1. Implement `DiscoveryProvider` in `src/server/discovery/providers/`.
2. Add it to the array in `providers/index.ts`.

Nothing else changes. `configured()` drives its status in Settings and whether it
appears in the wizard, and `normalize.ts` stays the only place a provider payload
becomes an internal entity.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run worker` | Background worker — discovery, audits, exports |
| `npm run build` / `start` | Production web build |
| `npm run db:push` / `db:seed` / `db:studio` | Schema, first account, data browser |
| `npm test` / `typecheck` | Test suite, strict type check |
| `npm run desktop:start` | Run the desktop app locally |
| `npm run desktop:dist` | Build the Windows installer |
| `npm run desktop:publish` | Build and upload to GitHub Releases |
| `npm run agent:dist` | Build the Lumen Agent installer |
| `npm run agent:publish` | Build and upload the agent installer |
