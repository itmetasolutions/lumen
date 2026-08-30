# Lumen

Universal business lead intelligence and website audit platform.

Discover businesses across multiple providers, resolve them into one record each,
audit their websites with reproducible evidence, detect overlapping sales
opportunities, and export exactly the leads you filtered.

> Not a Google Maps scraper. Google Places is one adapter behind a provider
> interface; OpenStreetMap works with no API key at all, so the product is
> functional with real data out of the box.

---

## Quick start

```bash
npm install
```

Create `.env` from the template:

```bash
cp .env.example .env
```

At minimum set `DATABASE_URL` and `AUTH_SECRET`:

```
DATABASE_URL="postgresql://postgres:PASSWORD@localhost:5432/lumen?schema=public"
AUTH_SECRET="a-long-random-string"
```

Create the schema and the first account:

```bash
npm run db:push
npm run db:seed
```

Run the app **and the worker** — they are separate processes on purpose, because
discovery and audits must never occupy a request thread:

```bash
npm run dev      # terminal 1 — http://localhost:3000
npm run worker   # terminal 2 — processes discovery, audit and export jobs
```

Sign in with the credentials the seed script printed, then go to
**Discovery → New Discovery**.

### Verify the setup

```bash
npm run typecheck   # strict TypeScript across the whole codebase
npm test            # 150 unit tests: dedupe, normalisation, SEO rules, scoring, filters, SSRF
```

---

## Desktop app (Windows .exe)

Lumen also packages as a self-contained Windows application with its own bundled
PostgreSQL and auto-update from GitHub Releases — no separate database, worker
terminal or Node install required.

```bash
npm run desktop:dist
```

The installer lands in `release/`. Full build, release and troubleshooting notes:
[`docs/DESKTOP.md`](docs/DESKTOP.md).

---

## What runs without any API keys

| Capability | Works unkeyed? | Notes |
|---|---|---|
| Business discovery | **Yes** | OpenStreetMap / Overpass, plus Nominatim geocoding. Attribution shown in the UI. |
| Website crawl + technical audit | **Yes** | Built-in fetcher with SSRF protection and robots compliance. |
| SEO audit | **Yes** | ~30 deterministic rules over the crawled DOM. |
| UX audit + screenshots | **Yes**, if a browser is installed | Drives an installed Edge/Chrome via `playwright-core`. Set `PLAYWRIGHT_CHANNEL`. |
| Performance | **Yes**, at low volume | PageSpeed Insights allows unkeyed calls at a strict quota. Add a PageSpeed key in Settings -> Connections for real volume. |
| Google Places discovery | No | Add a Google Places key in Settings -> Connections. |
| SerpApi discovery | No | Add one SerpApi key in Settings -> Connections to enable Google Maps, Yelp and Yandex engines. The default local cap is 250 searches/month. |
| AI-assisted UX commentary | No | Optional. Add an OpenAI key in Settings -> Connections. Never affects any score. |

**Settings -> Connections** stores workspace API credentials. **Settings -> Integrations**
probes every adapter live and tells you exactly what is missing. A provider with
no credentials is excluded from the source picker - it is never silently swapped
for another, and never faked.

---

## Architecture

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
Next.js 15 (App Router, RSC)  →  services (src/server/*)  →  JobQueue driver  →  worker
                                          ↓                                        ↓
                                    PostgreSQL / Prisma  ←──────────────────────────
```

**Queue driver.** `QUEUE_DRIVER=pg` (default) uses Postgres with
`SELECT … FOR UPDATE SKIP LOCKED` — real at-least-once delivery, retries with
exponential backoff, visibility timeouts and dead-lettering, with no second
datastore. `QUEUE_DRIVER=bullmq` + `REDIS_URL` swaps in BullMQ. Application code
only sees the `JobQueue` interface.

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
bad. SEO Opportunity 86 means there is a lot to sell. They are computed
separately, stored in separate columns and displayed separately.

**Opportunities overlap.** `needsWebsite`, `needsRedesign`, `needsSeo` and
`needsSpeed` are independent booleans. One business appears in every tab it
qualifies for.

**Nothing is fabricated.** Missing data is `NULL` and renders as `Not Found`.
Demo providers are not offered for new discovery runs. Older demo records, if
present, remain stamped `isDemo`, badged `DEMO DATA` in the UI, suppressed in
lead ranking, and carry a `DEMO DATA` column into every export.

**Every finding carries evidence.** An `AuditIssue` stores the selector queried,
the value measured, the viewport used and the URL affected. AI commentary is
stored with `source = AI_ASSISTED`, capped at MEDIUM confidence, and is excluded
from opportunity scoring entirely.

**Targeted re-audits merge, they do not replace.** Re-running only the UX checks
updates the UX projection and leaves SEO, speed and technical exactly as the last
audit that measured them left it. Each run declares which domains it is
*authoritative* over; everything else is carried forward, including the stored
opportunity reasons. Without this, a UX-only re-audit silently drops a business
out of the SEO tab. Covered by `tests/audit-merge.test.ts` and
`scripts/verify-merge-direct.ts`.

**History is append-only.** A re-audit writes a new `Audit` row. The denormalised
score columns on `Business` are a rebuilt projection of the latest audit, never
hand-authored, existing only so 100k+ rows can be filtered and sorted in Postgres.

**One filter compiler.** The table, the tab counts and the export all call
`compileQuery`. That is what makes "Export Current Filter" provably return the
rows on screen — there is no second code path to drift.

**Scoring weights are data.** Every number that influences a score lives in
`ScoringProfile.weights` and is editable in Settings → Scoring.

---

## Security

- Session cookies (httpOnly, SameSite=Lax, signed JWT), bcrypt password hashing
- Workspace isolation re-checked against the membership table on every request
- zod validation on every route; the filter DSL is an allowlist, not free-form SQL
- Per-IP rate limiting by route class
- Exports written server-side and served through an authorised handler
- **SSRF protection on the crawler**: scheme and port allowlists, DNS resolved
  before connect, private/loopback/link-local/CGNAT/metadata ranges rejected on
  **every redirect hop**, redirect cap, response size cap, content-type allowlist
- CSV cells beginning `= + - @` are prefixed to defuse spreadsheet formula injection

---

## Compliance (§30)

- Official provider APIs and permitted public sources only
- The crawler identifies itself, honours robots.txt and rate-limits per host
- No CAPTCHA solving or bot-protection evasion of any kind
- Contact details are collected only where the business publishes them publicly
- The application never sends outreach; contact status is recorded by hand

---

## Project layout

```
prisma/schema.prisma     data model
scripts/worker.ts        worker entrypoint
scripts/seed.ts          first user + workspace
src/app/                 routes (App Router) and API handlers
src/server/
  discovery/providers/   Google Places, OpenStreetMap, SerpApi adapters
  resolution/            entity resolution and merging
  crawler/               SSRF guard, safe fetch, robots, crawl
  audit/                 seo · performance · ux · technical + orchestrator
  scoring/               configurable weights, health, opportunity, lead score
  filters/               filter DSL and its Prisma compiler
  export/                column registry, CSV and XLSX writers
src/components/          UI, data table, filter builder, charts
tests/                   unit tests for the logic above
docs/ARCHITECTURE.md     full architecture write-up
```

## Adding a discovery provider

1. Implement `DiscoveryProvider` in `src/server/discovery/providers/`.
2. Add it to the array in `providers/index.ts`.

Nothing else changes. `configured()` drives its status in Settings and whether it
appears in the wizard; `normalize.ts` remains the only place a provider payload is
translated into the internal entity.
