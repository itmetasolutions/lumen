# Desktop build (Windows .exe) with auto-update

Lumen ships as a self-contained Windows application. It bundles its own
PostgreSQL, runs the Next server and the background worker as child processes,
and updates itself from GitHub Releases.

```
Lumen.exe (Electron main)
├── PostgreSQL          bundled, cluster in %APPDATA%\lumen\pgdata
├── Next server         .next/standalone/server.js on a free localhost port
├── Background worker   .next/standalone/worker.js — discovery, audits, exports
└── electron-updater    checks GitHub Releases, installs on quit
```

Nothing is sent anywhere and no internet connection is needed except for the
discovery providers themselves and the update check.

---

## Build commands

```bash
npm run desktop:build
```

```bash
npm run desktop:pack
```

```bash
npm run desktop:dist
```

| Command | What it does |
|---|---|
| `desktop:build` | Next standalone build, bundles the worker, compiles the Electron main process |
| `desktop:start` | Builds then runs Electron directly — the fast inner loop |
| `desktop:pack` | Unpacked app in `release/win-unpacked` — quickest packaging smoke test |
| `desktop:dist` | The installer: `release/Lumen-Setup.exe` |
| `desktop:publish` | Builds and uploads to GitHub Releases (needs `GH_TOKEN`) |
| `agent:pack` | Unpacked Lumen Agent in `release-agent/win-unpacked` |
| `agent:dist` | The agent installer: `release-agent/Lumen Agent-Setup.exe` |
| `agent:publish` | Builds and uploads the agent installer |

The installer is named `Lumen-Setup.exe` with **no version in the filename**.
That is deliberate: GitHub serves `/releases/latest/download/<asset-name>`, so a
fixed name gives a permanent download link that never has to be updated when you
publish a new version:

```
https://github.com/itmetasolutions/lumen/releases/latest/download/Lumen-Setup.exe
```

The version stays visible on the release page, in `latest.yml`, and in the app's
Help menu. Assets are scoped per release, so reusing the name across releases is
fine — and `electron-updater` resolves by the filename recorded in
`latest.yml`, which matches.

Current installer size is roughly **284 MB** — Electron, a full PostgreSQL, the
Next server and Chromium-driving dependencies.

---

## Releasing

The update feed is configured and the code is on GitHub:

- repository — `itmetasolutions/lumen`, branch `main`
- `package.json` → `build.publish` → `{ provider: github, owner: itmetasolutions, repo: lumen }`

That value is baked into `app-update.yml` inside the installer, which is how an
installed copy knows where to look for new versions.

To cut a release:

```bash
set GH_TOKEN=your_personal_access_token && npm run desktop:publish
```

The token needs `repo` scope ([create one here](https://github.com/settings/tokens)).
electron-builder uploads the installer, `latest.yml` and the `.blockmap`.

Because both publish configs set `releaseType: "release"`, the release is
**published straight away** rather than left as a draft. electron-builder's own
default is `draft`; this project overrides it. The assets are live to every
installed copy the moment the upload finishes.

If you would rather upload by hand, `npm run desktop:dist` produces the same
three files in `release/`; attach all three to a GitHub release tagged
`v<version>`. All three matter: `latest.yml` is the feed the updater reads, and
the `.blockmap` is what makes later updates download only changed blocks.

---

## The agent app

`Lumen Agent` is a second installer built from the same repository, configured
by `electron-builder.agent.json` with `electron/agent-main.ts` as its entry
point. It is a **thin client** and that is the whole design:

- No bundled PostgreSQL, no Next server, no background worker.
- It opens the team's Lumen server at `/agent` and does nothing else.
- Its only runtime dependency is `electron-updater`.

Bundling a database here would give every agent their own private copy of the
leads, which is the opposite of a shared queue. The `files` list in the agent
config is therefore a strict allowlist — `!node_modules/**/*` followed by
`electron-updater` and its transitive dependencies. Without it, electron-builder
pulls in every production dependency in `package.json`, which took the packaged
app from 345 MB to 914 MB and shipped Postgres binaries to people who will never
run a query.

`extraMetadata.name` is set to `lumen-agent`. Without it the build inherits
`name: "lumen"` from `package.json`, Electron hands it the *admin* app's
userData directory, and the two share a config file, a log and — fatally — a
single-instance lock: on a machine running both, the agent app silently refuses
to start because the admin app already holds it.

### First run

The agent is asked once for the address of the team's server. The address is
probed before it is accepted, so a typo produces an explanation rather than a
blank window. It is stored in:

```
%APPDATA%Lumen Agentagent-config.json
```

### Making the server reachable

The admin app binds to `127.0.0.1` on a random port by default. To let agents
connect, use **Team → Let my team connect** in the admin app: it rebinds to
`0.0.0.0` on the fixed port from `config.sharePort` (3210 by default) and
restarts. **Team → Show address for agents…** lists the addresses to hand out.

### Two apps, one repository, two update feeds

Both installers publish to the same GitHub repository and share a release. That
only works because they read **different update feeds**:

| | Installer | Feed |
|---|---|---|
| Lumen | `Lumen-Setup.exe` | `latest.yml` |
| Lumen Agent | `Lumen-Agent-Setup.exe` | `agent.yml` |

electron-updater looks for `latest.yml` unless told otherwise, so without this
the two feeds collide: whichever app published last wins, and the other offers
its installer to the wrong app — an agent's 97 MB client silently replaced by
the 300 MB server build on next launch.

Two settings keep them apart, and **both** are required:

- `publish.channel: "agent"` in `electron-builder.agent.json` — makes the build
  write `agent.yml` instead of `latest.yml`.
- `initUpdater({ channel: 'agent' }, …)` in `electron/agent-main.ts` — makes the
  installed app read it.

A release should carry five assets: both `.exe` files, both `.blockmap` files,
and both `latest.yml` and `agent.yml`.

### Releasing both

```bash
set GH_TOKEN=your_personal_access_token
npm run desktop:publish
npm run agent:publish
```

Run them in either order — they write different filenames, so neither
overwrites the other's assets.

### Releasing from GitHub instead

`.github/workflows/release.yml` does all of the above on GitHub's own Windows
runner. Nothing is built locally and there is no personal access token to
create — Actions issues a scoped one for the job.

```bash
# bump the version first, then:
git tag v0.2.0
git push origin v0.2.0
```

Or **Actions → Release → Run workflow** and type the version.

The job type-checks, runs the tests, refuses to continue if `package.json`
disagrees with the tag, then builds and uploads both installers.

**The release goes live immediately** — see the note above about
`releaseType`. Add the notes from `CHANGELOG.md` to the release body once it
appears. For a review step before shipping, set `releaseType` to `"draft"` in
both configs.

Two things it needs that are easy to miss if you adapt it:

- **`npx prisma generate` before the type check.** There is no postinstall hook,
  so a fresh `npm ci` has no generated client, and both the type check and the
  tests import it.
- **A syntactically valid `DATABASE_URL`.** `next build` constructs a Prisma
  client even though every page that reads the database is dynamic and nothing
  connects. The workflow sets one pointing at localhost; it is not a secret and
  nothing resolves it.

---

## How updating works

1. Bump `version` in `package.json`.
2. `npm run desktop:publish` — the release publishes itself.

Installed copies check on launch (8 seconds after start, so it never competes
with first paint) and from **Help → Check for Updates…**. A new version
downloads in the background; the user is offered *Restart now* or *Later*, and it
installs on quit either way.

Restarting mid-work is safe: discovery and audit jobs live in the database queue,
not in memory, so they resume after the restart rather than being lost.

The `.blockmap` file enables delta downloads — subsequent updates transfer only
the changed blocks rather than the whole 284 MB.

### Schema changes between versions

On every boot the app runs `prisma db push` against its bundled cluster, so a
release that adds columns migrates existing installs automatically.

This deliberately runs **without** `--accept-data-loss`. A release whose schema
would drop or retype existing data fails at startup with a visible error rather
than silently destroying someone's lead database. If you make such a change,
ship a migration rather than relying on `db push`.

---

## Where user data lives

```
%APPDATA%\lumen\
├── pgdata\        PostgreSQL cluster — the entire lead database
├── storage\       audit screenshots and generated exports
├── config.json    generated DB password, auth secret, update preferences
└── lumen.log      boot and runtime log
```

`config.json` holds a per-machine random database password and auth secret,
generated on first run. They are never shipped in the installer, so one leaked
binary exposes nobody's data.

The agent app keeps its own, deliberately separate, directory:

```
%APPDATA%Lumen Agent├── agent-config.json   the server address and window size
└── lumen.log           connection log
```

Uninstalling does **not** delete either folder (`deleteAppDataOnUninstall: false`)
— the first is the user's database, not application cache.

---

## Packaging decisions worth knowing

These were all found the hard way; changing them will break the build.

**`asar: false`.** PostgreSQL, the Prisma schema engine and Playwright each
derive their binary paths from `__dirname`. Inside an asar archive those paths
point into the archive, and Windows cannot execute a binary from there.
`asarUnpack` does not help, because the *computed* path still points at the
archive. Shipping plain files removes the whole class of failure.

**`afterPack` copies the standalone tree.** electron-builder deliberately skips
any `node_modules` directory inside an `extraResources` source, since it manages
dependencies itself. That silently produced an installer whose server died with
`Cannot find module 'next'`. `scripts/after-pack.js` copies the tree directly and
fails the build if anything essential is missing.

**`prisma` is a runtime dependency.** It is not just a build tool here — the CLI
runs at startup to migrate the bundled cluster.

**Child processes use `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.**
Electron ships no separate `node` binary; this is the supported way to spawn one.

**Dynamically-imported packages are copied explicitly.** Next traces static
imports only. `playwright-core` and `exceljs` are loaded via `await import(...)`
at runtime, so `scripts/build-desktop.mjs` copies them in — otherwise the UX and
export stages fail in the packaged app while working in development.

**The worker is bundled with esbuild**, with `server-only` neutralised, so the
packaged app needs no TypeScript runtime.

---

## Recovery and diagnostics

The app writes every boot stage to `%APPDATA%\lumen\lumen.log`, reachable from
**Help → Open Data & Logs Folder**. If startup fails, the splash window shows the
failing stage and the error instead of hanging.

A force-quit or power loss leaves a stale `postmaster.pid` that would normally
stop PostgreSQL from ever starting again. The app detects a lock whose process no
longer exists and clears it, while never touching a lock that is genuinely held.

---

## Code signing

The installer is **unsigned**. Windows SmartScreen will warn users with
"Windows protected your PC" until enough installs build reputation.

Auto-update works unsigned, but for distribution to other people you want an
Authenticode certificate (OV is cheapest; EV clears SmartScreen immediately).
Add to `build.win`:

```json
"win": { "certificateFile": "cert.pfx", "certificatePassword": "..." }
```

Use `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables rather than committing
the certificate.

---

## Other platforms

macOS and Linux need only a target added to `build`, plus the matching
`@embedded-postgres/*` package — the platform packages for darwin-arm64,
darwin-x64 and the Linux architectures already exist. Builds must run on the
target OS (or in CI), and macOS additionally requires signing and notarisation.
