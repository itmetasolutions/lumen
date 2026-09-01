# Changelog

## v0.2.2 — agents can actually sign in

**If you have Lumen Agent, update both apps.** Until this release an agent could
not sign in at all: the password was accepted, the page reloaded, and the form
came back empty. Nothing was wrong with the account or the password.

### What went wrong

The session cookie was marked `Secure` whenever the app ran a production build
— which the desktop app always does. A browser silently discards a `Secure`
cookie on any address that is not a secure context, and agents reach their
Lumen over plain HTTP on the local network, like `http://192.168.1.14:3210`.

So the sign-in succeeded, the cookie was thrown away without a word, and the
very next request looked like a stranger's. Straight back to the login page.

It survived every test because the main app talks to `127.0.0.1`, and localhost
*is* a secure context — it accepts the cookie happily. Only connections from
another machine broke, which is the one thing the agent app exists to do.

### The fix

The cookie now follows the actual connection rather than the build type. Over
HTTPS it is still marked `Secure`; over a plain local network it is not, because
there is no TLS to protect. A reverse proxy terminating TLS is honoured through
`x-forwarded-proto`, so a proper HTTPS deployment keeps the stronger cookie.

Verified end to end against a real production build over a LAN address, not just
in unit tests: sign in, session persists across requests, and a request without
the cookie still bounces to the login page as it should.

### Also

Releases are built and published in one piece again. v0.2.1 went out as two
GitHub releases sharing a tag, with the installers split between them, so half
the download links returned 404. The workflow now creates the release once
before either build and refuses to finish if the tag carries more than one
release or is missing any of its six assets.

### Install

**[Lumen-Setup.exe](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Setup.exe)** — update first; the fix is server-side, so this is the one that matters.

**[Lumen-Agent-Setup.exe](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Agent-Setup.exe)** — then your agents. A v0.2.0 agent still cannot update itself and must be replaced by hand once.

---

## v0.2.1 — Lumen Agent starts again

**If you installed Lumen Agent from v0.2.0, update it.** That build could not
launch: it opened a dialog reading *"Cannot find module './server-url'"* and
quit. The main Lumen app was never affected.

### What went wrong

The agent installer lists the files it ships one by one, rather than taking
everything. That is deliberate — it is a client, and an allow-list is what keeps
it at 97 MB instead of carrying the server, the database and PostgreSQL.

The cost is that adding a module and forgetting to list it produces a build that
packages, signs and installs perfectly, then dies the moment it starts. Nothing
in the pipeline objects, because from the packager's point of view nothing is
wrong: it packed exactly what it was told to.

`server-url.js` — which reads and validates the server address you type on
first run — was never on the list.

### The fix

The file is now included, and `scripts/verify-agent-package.mjs` walks the
agent's real require graph at build time and fails the build if anything it
reaches is missing. It reproduces the v0.2.0 failure when the entry is removed,
so this class of bug cannot ship silently again.

### Install

**[Lumen-Agent-Setup.exe](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Agent-Setup.exe)** — install over the broken v0.2.0; nothing needs uninstalling first.

A v0.2.0 agent cannot update itself, because it never starts long enough to
check. Download it once by hand and it will keep itself current from here.

**[Lumen-Setup.exe](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Setup.exe)** — unchanged from v0.2.0 apart from the version. Existing installs will offer it; there is nothing new in it for you.

---

## v0.2.0 — the calling half

v0.1.0 found leads and told you which were worth calling. This release covers
what happens next: assigning them, calling them, and reporting on the work.

Lumen is now **two applications** over one database. The app you already have
becomes the supervisor's: it finds leads and hands them out. A second, much
smaller app — **Lumen Agent** — goes on each caller's machine and shows them
their queue and nothing else.

If you work alone, nothing changes. The new sections stay out of your way and
you can ignore the second app entirely.

### Install

**[Lumen-Setup.exe](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Setup.exe)** — the main app. Update over your existing install; your database is untouched.

**[Lumen-Agent-Setup.exe](https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Agent-Setup.exe)** — for your callers. 97 MB, no database of its own.

Windows will show **"Windows protected your PC"** on both, because neither is
code-signed yet. Click **More info → Run anyway** — worth warning your agents
before they hit it.

Existing installs update themselves. The two apps read separate update feeds, so
an agent is never offered the main build by mistake.

---

## Cold calling

### Your team

**Team** is where accounts come from, and the only place. There is no sign-up
page into your workspace — if someone can see your leads, you put them there.
Creating an account produces a temporary password shown **once**; the agent is
made to replace it the first time they sign in.

People are *disabled*, never deleted. Their call history is what the reports are
built from, and deleting the account would take a month of records with it.
Disabling someone returns their leads to the pool the same minute.

### Handing out work

Assign leads one at a time from a lead's page, in bulk from any filtered view,
or automatically. Assigning "everything matching this filter" resolves through
the same compiler the table uses, so it means exactly what is on your screen —
the same guarantee the export has always made.

A business that has asked not to be contacted is never assigned to anyone, by
any route, including the automatic ones.

### The live floor

Who is online, who is on shift, which lead each agent has open right now, calls
and contact rate so far today, and a running feed of outcomes as they land.
Refreshes every five seconds and pauses when you switch tabs.

### Reports

A report per agent per day, written once and stored — so a number you read on
Tuesday still says the same thing on Friday. Days close themselves in the
evening, in your workspace's timezone, and there is a button if you want today's
early.

Contact rate and calls-per-hour show a dash rather than a zero when there is
nothing to divide by. An agent who made no calls had no contact rate; reporting
0% would read as a terrible day rather than an empty one.

### What an agent sees

A queue, not a database. The order is the calling strategy and is not
adjustable: follow-ups you have already missed, then ones due today, then leads
never called ranked by lead score, then everything worked but unscheduled.

**Clock in and out.** Shift time and active time are tracked separately — the
first is clock-in to clock-out, the second only accrues while the app is
actually being used. A laptop left open overnight adds no work, and active time
can never exceed the shift it happened in.

**One screen per call:** the number, the business, what is worth talking about,
eleven outcomes, notes, and a follow-up date that is *mandatory* for any outcome
that promises one. You cannot save "callback requested" without saying when.

Call records cannot be edited or deleted. A mistake is corrected by logging
another call with a note, the way a ledger is corrected — by a new entry, not an
erasure. That is what makes the reports worth reading.

Agents cannot run discovery, export, import, or see anyone else's leads. Those
are refusals at the server, not hidden buttons, and an agent can only log calls
against leads actually assigned to them.

### Things that happen on their own

The background worker checks every five minutes and decides what is due, so a
computer that was off for a day catches up rather than losing it:

- Writes each day up into reports after your chosen hour.
- Fills in yesterday's reports if nothing was running when the day ended.
- Closes shifts people forgot to clock out of — ending them at the last activity
  recorded, not at whatever time you noticed.
- Returns leads nobody has touched in *N* days to the pool, never one with a
  follow-up still ahead of it.
- Tops each agent back up to their target queue size, best leads first.

All of it lives in **Settings → Calling**, and all of it is off by default except
the end-of-day write-up.

### Letting your team connect

The main app talks only to your own computer by default. **Team → Let my team
connect** opens it to your network on a fixed port and restarts; **Team → Show
address for agents…** gives you the address to read out. Your agents type it
once when they first open Lumen Agent.

Only do this on a network you trust. Anything that can reach your computer can
reach the sign-in page — an account you created is still needed to see anything,
but the login form itself becomes reachable.

---

## Also new since v0.1.0

### Import leads from another Lumen

Upload a CSV or XLSX exported from another workspace. Every row runs through the
same matching as discovery, so an overlapping file merges into your existing
leads instead of creating a second copy of every business.

Audit results are deliberately left behind. Lead score, SEO health and
opportunity flags describe an audit that ran somewhere else; carrying them across
would show you another installation's measurements as your own. The importer
lists which columns it ignored and why.

### Audit everything unaudited, in one action

Queues audits for every business that has never been audited, respecting your
current filter and tab. It tells you the real numbers before you commit — how
many match, how many actually have a website — because several hundred audits is
hours of crawling. Clicking twice cannot double-queue the same work.

Audit status is now a filter field too, which is how you find the unaudited set
in the first place.

### Find missing details, without spending search quota

For any single business: derives likely domains from its name, accepts one only
when the live page proves it belongs to that business, crawls the confirmed site,
reads its structured data, and matches Yelp Fusion. A newly found website is
queued for audit automatically. Every step reports what it found — including
where it looked when it found nothing.

### Yelp Fusion

A first-class discovery source with its own free tier, separate from the SerpApi
quota. It returns the website URL and price range the SerpApi Yelp engine leaves
empty.

---

## Fixes

- **Days were an hour wrong twice a year.** The reporting day resolved its
  timezone offset once and reused it for both ends, so on the mornings the clocks
  change an hour of calls was filed under the wrong day.
- **Phone numbers were corrupted by an export/import round trip.** The CSV writer
  prefixes cells starting with `=` `+` `-` `@` so a spreadsheet cannot execute
  them — and every international phone number starts with `+`. Importing stored
  `'+441612345678`. The guard is now reversed on the way in, and only when the
  next character was actually one that got guarded, so a name genuinely starting
  with an apostrophe survives.
- **A targeted re-audit could erase other scores.** Re-running only the UX stage
  cleared the SEO health of a business and dropped it out of the SEO tab. Each
  audit domain now keeps its own last known result.
- **Discovery made one database round trip per audit.** A run finding 500
  businesses made 500 separate calls to queue their audits; it is one now.

---

## Your data

Everything still stays on your machine, in `%APPDATA%\lumen\` — database,
screenshots and exports. Lumen Agent stores only the address of your server, in
`%APPDATA%\Lumen Agent\`.

Upgrading updates the database in place and keeps everything. Uninstalling does
not delete your data.

## Known limitations

- **Neither app is code-signed**, so SmartScreen warns on install.
- **Windows only.** macOS and Linux need only a build target and the matching
  Postgres package.
- **~700 MB on disk** for the main app; ~350 MB for Lumen Agent.
- **Agents connect over your own network.** There is no hosted option — for
  people working from home you would deploy the web app somewhere reachable and
  point their installers at it.
- **The map is a spatial plot, not a street map.** It renders offline with no
  third-party requests; there are no map tiles behind the points.
- **Google Sheets export** is not implemented; exports are CSV and XLSX.
- **No dialler integration.** Numbers are one click to copy, and open in whatever
  your machine handles `tel:` links with. Lumen does not place calls.
- **Scheduled re-auditing** is still manual. The re-check queue surfaces stale
  records; you start the re-audits.

## Compliance

Unchanged: official provider APIs and permitted public sources only. The crawler
identifies itself, honours robots.txt and rate-limits per host. No CAPTCHA
solving or bot-protection evasion. Contact details are collected only where a
business publishes them publicly.

Lumen still sends nothing on your behalf. It records what your team did after
they called; it does not call, email or message anyone.

## Requirements

Windows 10 or 11, 64-bit, for both apps. The main app wants Microsoft Edge or
Google Chrome present for UX audits and screenshots — optional for everything
else. Lumen Agent needs a network route to your Lumen and nothing more.

---

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
