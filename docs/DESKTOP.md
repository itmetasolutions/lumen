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
| `desktop:dist` | The installer: `release/Lumen-Setup-<version>.exe` |
| `desktop:publish` | Builds and uploads to GitHub Releases (needs `GH_TOKEN`) |

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
electron-builder creates a **draft** release and uploads the installer,
`latest.yml` and the `.blockmap`.

**Publish the draft on GitHub afterwards — the updater ignores drafts.**

If you would rather upload by hand, `npm run desktop:dist` produces the same
three files in `release/`; attach all three to a GitHub release tagged
`v<version>`. All three matter: `latest.yml` is the feed the updater reads, and
the `.blockmap` is what makes later updates download only changed blocks.

---

## How updating works

1. Bump `version` in `package.json`.
2. `npm run desktop:publish`, then publish the draft release on GitHub.

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

Uninstalling does **not** delete this folder (`deleteAppDataOnUninstall: false`)
— it is the user's database, not application cache.

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
