# Changelog

## v0.1.0 — first release

Lumen finds local businesses, audits their websites with reproducible evidence,
and tells you which ones are worth calling and why.

Search a market — *"Roofing companies in Dallas"* — and get back a deduplicated
list of businesses, each with a scored, evidence-backed answer to: is there a
website at all, does it need a redesign, does it have SEO problems, is it slow,
and how strong a lead is this?

### Install

Download **[Lumen-Setup.exe](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Setup.exe)** and run it.

Windows will show **"Windows protected your PC"** because this build is not yet
code-signed. Click **More info → Run anyway**.

First launch takes about a minute while the app sets up its local database. The
splash screen shows each step.

Nothing else to install — PostgreSQL and the background worker are bundled.

### What it does

**Discovery across five sources.** OpenStreetMap (no API key needed), Google
Places, and SerpApi's Google Maps, Yelp and Yandex engines. Large areas are split
into overlapping geographic cells so results are not capped by a single query,
and industry terms expand into curated variations — your own wording always runs
first, and expansions are recorded separately.

**One record per business.** Results from every source are matched and merged on
name, phone, domain, address and coordinates, keeping full provenance. Two
branches of the same chain stay separate; the same shop found three ways becomes
one lead.

**Evidence-based website audits.** SEO, performance, UX and technical checks run
as independent stages. Each finding records the selector queried, the value
measured, the viewport used and the URL affected — so "your navigation overlaps
at 390px" replaces "your site looks dated". A failing stage never discards the
others.

**Overlapping opportunities.** Website Creation, Redesign, SEO and Speed are
independent flags. A business appears in every tab it qualifies for, and each
one shows exactly why it triggered.

**Seven lead tabs** with composable AND/OR filters over 55 fields, saved views,
server-side search, and CSV/XLSX export of everything, exactly your current
filter, or just the rows you ticked — choosing from 51 fields.

**Contact enrichment.** Crawls a business's own website to recover missing phone
numbers, emails and social profiles, and a one-click cleanup for leads with no
contact route at all.

**Auto-update.** Checks on launch and from *Help → Check for Updates…*, downloads
in the background, and offers to restart. Running jobs survive a restart — they
live in the database queue, not in memory.

### Works without any API keys

Discovery via OpenStreetMap, website crawling, SEO audits, contact enrichment,
and UX audits with screenshots (needs Edge or Chrome installed) all run unkeyed.
PageSpeed works unkeyed at a low daily quota.

Add keys in **Settings → Connections** for Google Places, SerpApi and higher
PageSpeed volume. **Settings → Integrations** probes every provider live and
tells you what is missing — a provider without credentials is excluded and never
silently swapped or faked.

SerpApi's three engines share one monthly quota, capped at 250 searches by
default and cross-checked against your real SerpApi balance. When it runs out
those engines report exhausted with the renewal date rather than failing
mid-search.

### Your data

Everything stays on your machine, in `%APPDATA%\lumen\` — the database, audit
screenshots and exports. The app works offline apart from the discovery
providers themselves and the update check. The database password and auth secret
are generated locally on first run, so they are not shipped in the installer.

Uninstalling does not delete your data.

### Known limitations

- **Not code-signed**, so SmartScreen warns on install.
- **Windows only** for now. macOS and Linux need only a build target and the
  matching Postgres package.
- **~700 MB on disk** after install — Electron, a full PostgreSQL and a browser
  automation stack.
- **The map is a spatial plot, not a street map.** It renders offline with no
  third-party requests; filters and click-to-open work, but there are no map
  tiles behind the points.
- **No CSV import** yet — discovery is API and crawl based.
- **Google Sheets export** is not implemented; the export layer supports CSV and
  XLSX.
- Scheduled/automatic re-auditing is not built. The re-check queue surfaces stale
  records, but re-audits are started by hand.

### Compliance

Official provider APIs and permitted public sources only. The crawler identifies
itself, honours robots.txt and rate-limits per host. No CAPTCHA solving or
bot-protection evasion. Contact details are collected only where a business
publishes them publicly. The app never sends outreach — contact status is
recorded by hand.

### Requirements

Windows 10 or 11, 64-bit. Microsoft Edge or Google Chrome for UX audits and
screenshots (optional for everything else).
