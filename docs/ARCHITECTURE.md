# Lumen — Universal Business Lead Intelligence & Website Audit Platform

> Discovery → Entity Resolution → Audit → Opportunity → Qualification → Export.

## 0. Non-negotiable principles

1. **Never fabricate.** Missing data is stored as `NULL` and rendered as `Not Found`. Demo providers are not offered for new discovery runs; older demo records remain labelled `DEMO DATA` at the record level (`BusinessSource.isDemo`, `Audit.isDemo`).
2. **Evidence or it didn't happen.** Every `AuditIssue` carries machine-collected `evidence` (selector, snippet, measured value, URL). AI findings are stored with `source = AI_ASSISTED` and never upgrade a deterministic verdict.
3. **Health is not Opportunity.** Health is "how good is it" (0–100, higher better). Opportunity is "how much is there to sell" (0–100, higher better for us). Separate columns, separately computed.
4. **Opportunities overlap.** `needsWebsite`, `needsRedesign`, `needsSEO`, `needsSpeed` are independent booleans with independent scores. A business appears in every tab it qualifies for.
5. **History is append-only.** Audits are never updated in place. Each run writes a new `Audit` row; `Business.latest*` columns are denormalised pointers for fast filtering.
6. **Provider independence.** Google is one adapter among many behind `DiscoveryProvider`. Removing it must not break the system.
7. **Nothing large runs in a request.** Discovery and audits run in queue workers, streamed to the UI via progress events.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Next.js 15 App Router (React 19, TypeScript, Tailwind)              │
│  Server Components read Postgres directly (workspace-scoped)         │
│  Client islands: data table, filter builder, charts, wizard, map     │
└───────────────┬──────────────────────────────────────────────────────┘
                │ Route Handlers (/api/*) — zod-validated, session-authed
┌───────────────▼──────────────────────────────────────────────────────┐
│  Application services (src/server/*)                                 │
│  discovery │ resolution │ crawler │ audit │ scoring │ export │ jobs  │
└───────────────┬───────────────┬──────────────────────────────────────┘
                │ enqueue()     │ read/write
┌───────────────▼───────────────┴──────────────────────────────────────┐
│  JobQueue driver (pluggable)      │  PostgreSQL + Prisma             │
│   - PgQueue      (default)        │  workspace-isolated, JSONB for   │
│   - BullMQQueue  (Redis)          │  raw provider payloads/evidence  │
└───────────────┬──────────────────────────────────────────────────────┘
                │ worker process (npm run worker)
┌───────────────▼──────────────────────────────────────────────────────┐
│  Pipelines: discovery.run → website.detect → audit.site              │
│             → seo · perf · ux · technical → score → classify         │
│  Adapters:  DiscoveryProvider │ PerformanceProvider │ AIProvider     │
│             StorageProvider   │ GeocodingProvider                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Why a queue *driver*, not BullMQ directly

Redis is not present on every target machine (it is not on this one). `JobQueue` is an
interface; `PgQueue` implements it with `SELECT ... FOR UPDATE SKIP LOCKED`, giving real
at-least-once delivery, retries, exponential backoff, visibility timeouts and a
dead-letter state without a second datastore. `BullMQQueue` is a drop-in swap via
`QUEUE_DRIVER=bullmq` + `REDIS_URL`. Application code never imports either directly.

---

## 2. Folder structure

```
prisma/schema.prisma            single source of truth for the data model
scripts/worker.ts               worker entrypoint (npm run worker)
src/
  app/
    (auth)/login | register
    (app)/
      dashboard
      discovery/new | jobs | jobs/[id]
      leads/[tab]                 all | website-creation | redesign | seo | speed | hot
      businesses/[id]             full intelligence profile
      audits/recent | recheck
      exports
      views                       saved views
      map
      settings/integrations | scoring | audit-rules | workspace
    api/
      auth/*  discovery/*  businesses/*  leads/*  export/*
      jobs/*  audits/*  views/*  settings/*  progress/[jobId]
  server/
    db/                prisma client singleton
    auth/              session, password hashing, guards
    queue/             JobQueue iface, PgQueue, BullMQQueue, registry, runner
    discovery/
      providers/       google-places, openstreetmap, serpapi maps/yelp/yandex
      tiling.ts        geo grid / bbox subdivision
      expansion.ts     category and keyword expansion
      normalize.ts     provider payload → Business draft
      run.ts           the discovery pipeline
    resolution/        entity resolution, blocking keys, match scoring, merge
    crawler/           fetcher, robots, ssrf guard, url normalize, page pool
    audit/
      seo/             deterministic rule set
      performance/     providers: psi, lighthouse
      ux/              playwright deterministic checks + optional AI
      technical/       status, redirects, ssl, mixed content, links
      run.ts           audit orchestrator (QUICK | STANDARD | DEEP)
    scoring/           weights config, health scores, opportunity scores, lead score
    filters/           filter DSL → Prisma where (AND/OR trees)
    export/            column registry, CSV writer, XLSX writer, export jobs
    normalize/         phone, url, domain, name, address
  components/
    ui/                button, input, select, dialog, badge, table primitives
    data-table/        server-driven table, columns, bulk actions
    filters/           composable filter builder
    charts/            hand-rolled SVG charts (no chart dependency)
  lib/                 cn(), formatting, constants, shared types
```

---

## 3. Database schema (entities and relationships)

```
User ─┬─< Membership >─┬─ Workspace ─┬─< ApiCredential
      │                │             ├─< ScoringProfile
      └─< AuditLog     │             ├─< SavedView
                       │             ├─< DiscoveryJob ─┬─< SearchQuery
                       │             │                 └─< JobEvent
                       │             ├─< Business
                       │             └─< ExportJob

Business ─┬─< BusinessSource   provenance: provider, providerId, retrievedAt,
          │                    confidence, isDemo, raw JSONB
          ├─< BusinessContact  PHONE|EMAIL|SOCIAL, value, normalized, source,
          │                    confidence, isPrimary
          ├─ Website (1:1 optional) ─< Audit
          ├─< Opportunity      kind, score, triggered, reasons JSONB (one row per kind)
          ├─ OutreachStatus (1:1) ─< OutreachNote
          └─  tags String[]

Audit ─┬─ SEOResult          (1:1)
       ├─ PerformanceResult  (0..2 — MOBILE and DESKTOP strategies)
       ├─ UXResult           (1:1) ─< Screenshot
       ├─ TechnicalResult    (1:1)
       ├─< AuditIssue        type, category, severity, confidence, title,
       │                     evidence JSONB, affectedUrl, recommendedAction
       └─< CrawledPage       url, status, redirectChain, contentType, bytes
```

**Denormalised on `Business` for fast server-side filtering and sorting** (all nullable,
all rebuilt from the latest completed audit, never authored by hand):
`leadScore, dataConfidence, websiteHealth, seoHealth, perfHealthMobile, perfHealthDesktop,
uxHealth, technicalHealth, websiteCreationOpp, redesignOpp, seoOpp, speedOpp,
needsWebsite, needsRedesign, needsSeo, needsSpeed, lastAuditedAt, lastSeoAuditAt,
lastPerfAuditAt, lastUxAuditAt, lastCrawledAt, discoveredAt, lastSeenAt`.

Rationale: the master table must filter, sort and paginate over 100k+ rows server-side.
Joining five audit tables per row per query is not viable; the denormalised columns are
indexed and the authoritative history stays in the `Audit*` tables.

**Date fields kept distinct**: `createdAt, discoveredAt, lastSeenAt, lastCrawledAt,
lastAuditedAt, lastPerfAuditAt, lastSeoAuditAt, lastUxAuditAt, updatedAt`.

**JSONB is used only for**: raw provider payloads, issue evidence, opportunity reason
arrays, filter definitions, scoring weights. Never for queryable business attributes.

---

## 4. Data flow

```
Wizard ──POST /api/discovery──▶ DiscoveryJob(PENDING) ──enqueue discovery.run──▶ worker
                                                                                   │
  ┌────────────────────────────────────────────────────────────────────────────────┘
  ▼
1 PLAN      location → geo cells (tiling)  x  industry → expanded terms
            → SearchQuery rows (original vs expanded flagged)
2 DISCOVER  for each (cell x term x provider): provider.search() → RawBusiness[]
            rate-limited, budgeted, per-provider error isolation
3 NORMALIZE name/phone/url/domain/address normalisation → BusinessDraft
4 RESOLVE   blocking keys → candidate pairs → match score → merge or insert
            provenance appended, never overwritten by lower confidence
5 DETECT    website present? reachable? canonical? → Website row
6 AUDIT     fan out one audit.site job per business (depth-dependent)
              crawl → technical → seo → performance → ux
              each stage independently OK/FAILED/SKIPPED → audit status
              PARTIAL if some stages failed
7 SCORE     health scores → opportunity scores → lead priority score
8 CLASSIFY  Opportunity rows written; denormalised flags updated on Business
9 DONE      coverage report: sources, queries, cells, found, unique, dupes, errors
```

Every stage emits a `JobEvent` (stage, message, counters) which drives the live progress view.

---

## 5. Provider architecture

```ts
interface DiscoveryProvider {
  readonly id: string                     // 'google-places'
  readonly label: string
  readonly isDemo: boolean
  configured(): Promise<ProviderStatus>   // CONNECTED | NOT_CONFIGURED | ERROR
  capabilities(): ProviderCapabilities    // radius? bbox? ratings? contacts?
  search(q: DiscoveryQuery, ctx): Promise<RawBusiness[]>
  estimateCost(q): CostEstimate
}
```

Implementations: `GooglePlacesProvider`, `OpenStreetMapProvider` (Overpass),
`SearchProvider` (SerpApi Google Maps), `SerpApiYelpProvider`,
`SerpApiYandexProvider`. Each returns
`RawBusiness`; its own wire shape is confined to the adapter, and `normalize.ts` is the
only place that maps to the internal entity. Same pattern for:

```ts
interface PerformanceProvider { run(url, strategy): Promise<PerfMeasurement> }   // psi | lighthouse
interface AIProvider          { analyzeScreenshots(...): Promise<AIFinding[]> }  // openai | mock
interface StorageProvider     { put(key, buf, mime): Promise<string> }           // s3 | local disk
```

**Missing credentials never produce invented results.** A provider reporting
`NOT_CONFIGURED` is excluded from the source picker with a visible reason. Older
demo rows, if present, keep the `DEMO DATA` badge that survives export.

---

## 6. Queue architecture

Queues: `discovery` (concurrency 2), `audit` (4–8), `export` (2), `recheck` (2).

`PgQueue` semantics: `Job(id, queue, name, payload, state, attempts, maxAttempts, runAt,
lockedAt, lockedBy, lastError)`; claim via `FOR UPDATE SKIP LOCKED`, heartbeat lock
renewal, visibility-timeout reclaim, exponential backoff `base * 2^n` with jitter,
terminal `DEAD` state retaining `lastError`. Per-provider token-bucket rate limiting and
per-workspace daily budgets are enforced in the worker before any external call.

---

## 7. API endpoints (selection)

```
POST   /api/auth/register | login | logout
POST   /api/discovery                     create + enqueue discovery job
GET    /api/discovery/jobs                list        GET /api/discovery/jobs/:id
POST   /api/discovery/jobs/:id/rerun | duplicate | cancel
GET    /api/progress/:jobId               live progress
GET    /api/leads                         tab + filter DSL + sort + page (server-side)
POST   /api/leads/enrich-missing          crawl owned sites for missing contacts
DELETE /api/leads/no-contact              delete leads with no phone/email/site/social
GET    /api/leads/counts                  live per-tab counts under current filter context
GET    /api/businesses/:id                full profile
POST   /api/businesses/:id/reaudit        {scopes:['seo','perf','ux','technical']}
PATCH  /api/businesses/:id/outreach       status, notes, tags, follow-up dates
POST   /api/export                        {scope: all|filter|selected, format, columns}
GET    /api/export/:id/download           streamed file
GET/POST/DELETE /api/views                saved views
GET/PUT /api/settings/integrations|scoring|audit-rules
```

The filter DSL (composable AND/OR) is validated by zod and compiled to a Prisma `where`
by `src/server/filters/compile.ts`. **The same compiler serves the table, the counts and
the export** — that is what guarantees "Export Current Filter" returns exactly the
visible set.

---

## 8. Audit engine

```
audit.site(businessId, depth)
  ├─ crawl        depth-scoped page set (QUICK 1, STANDARD <=8, DEEP <=40)
  │               robots-aware, SSRF-guarded, rate-limited, timeout + retry per page
  ├─ technical    status codes, redirect chains, TLS, mixed content, broken links,
  │               missing assets, console errors (when the browser stage ran)
  ├─ seo          deterministic rules over crawled DOM (title, meta, H1, headings,
  │               canonical, robots/sitemap, indexability, alt text, schema, OG, links)
  ├─ performance  PSI mobile + desktop (separate rows) or Lighthouse
  ├─ ux           Playwright 1440x900 + 390x844 — horizontal overflow, overlap,
  │               broken/missing images, tap-target size, contrast, viewport meta,
  │               console errors → screenshots → optional AI pass
  └─ finalize     issues → health scores → opportunity scores → lead score → flags
```

Stage isolation: a thrown stage is recorded `FAILED` with its error, the audit continues
and finishes `PARTIAL`. One broken website can never fail a job.

---

## 9. Scoring model

All weights live in a `ScoringProfile` row (JSONB, per workspace, editable in Settings) —
no magic numbers scattered through the code.

```
health(domain)    = 100 - Σ(issue.severityWeight × issue.confidenceWeight)   clamped 0..100
opportunity(kind) = w1·(100 - relevantHealth) + w2·evidenceStrength
                    + w3·businessValue - w4·uncertainty                      clamped 0..100
leadPriority      = w_need·maxOpportunity + w_reach·contactability
                    + w_cred·credibility(reviews, rating, dataConfidence)
                    + w_evid·evidenceStrength
```

`leadPriority` deliberately weights contactability and credibility, so a dreadful website
belonging to an unreachable business does not outrank a reachable, credible one. Every
score persists its `reasons[]` so the UI can always answer "why 91?".

---

## 10. Security

Session cookies (httpOnly, SameSite=Lax, signed JWT via `jose`), bcrypt password hashing,
workspace isolation enforced through a single scoped data-access helper (every query
takes `workspaceId`), zod on every input, per-IP and per-user rate limits, exports written
server-side and served through an authorised handler rather than a public URL.

**SSRF guard** (critical — the crawler consumes arbitrary URLs): scheme allowlist
(http/https), DNS resolution before connect, rejection of private/loopback/link-local/
CGNAT/multicast/reserved ranges for **every hop** of a redirect chain, redirect cap, port
allowlist, response size cap, content-type allowlist, per-host concurrency limits.

---

## 11. Environment variables

Only infrastructure variables are required in `.env`. API provider keys are stored per
workspace from Settings -> Connections, with environment variables still supported as
server-side fallbacks. Settings -> Integrations shows live status.

```
DATABASE_URL=            # required
AUTH_SECRET=             # required
QUEUE_DRIVER=pg|bullmq   # default pg
REDIS_URL=               # required only when QUEUE_DRIVER=bullmq
GOOGLE_MAPS_API_KEY=     # optional fallback for Google Places discovery
GOOGLE_PAGESPEED_API_KEY=# optional fallback for PageSpeed Insights
SEARCH_PROVIDER_API_KEY= # optional fallback for SerpApi discovery
SERPAPI_MONTHLY_LIMIT=   # optional local monthly cap, defaults to 250
OPENAI_API_KEY=          # optional fallback for AI-assisted UX
S3_ENDPOINT= S3_ACCESS_KEY= S3_SECRET_KEY= S3_BUCKET=   # optional fallback; local disk otherwise
PLAYWRIGHT_CHANNEL=      # msedge|chrome — reuse an installed browser for the UX stage
```

---

## 12. Implementation phases

P1 foundation · P2 discovery + dedupe · P3 master DB + filters + views · P4 crawler +
website detection · P5 SEO · P6 performance · P7 UX · P8 opportunity engine · P9 service
tabs · P10 export · P11 dashboard · P12 hardening and tests.
