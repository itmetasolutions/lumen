import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { databaseDir, resourceRoot, prismaSchema, nodeExecutable, nodeChildEnv } from './paths'
import type { AppConfig } from './config'
import { databaseUrl } from './config'
import { log } from './log'

/**
 * Bundled PostgreSQL.
 *
 * The application's schema leans on Postgres-specific features — scalar list
 * columns, JSONB, case-insensitive filters and `SELECT … FOR UPDATE SKIP LOCKED`
 * in the job queue — so the desktop build ships a real Postgres rather than
 * substituting SQLite, which would have required rewriting the schema, the queue
 * driver and the filter compiler.
 *
 * The cluster lives in the user's data directory, so every install is
 * independent and the app works with no network connection.
 */

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  createDatabase(name: string): Promise<void>
}

let instance: EmbeddedPostgresInstance | null = null

type EmbeddedPostgresCtor = new (options: Record<string, unknown>) => EmbeddedPostgresInstance

/**
 * Loads embedded-postgres from the unpacked resources directory by absolute path.
 *
 * The platform package derives its binary locations from `import.meta.url`. If
 * the module were loaded from inside the asar archive those paths would point at
 * `app.asar/…/postgres.exe`, and Electron cannot execute a binary from inside an
 * archive. Importing the copy that lives in `resources/app/node_modules` makes
 * every derived path a real file on disk.
 *
 * The same absolute path works in development, where resourceRoot() is the repo.
 */
async function loadEmbeddedPostgres(): Promise<EmbeddedPostgresCtor> {
  const entry = path.join(
    resourceRoot(),
    'node_modules',
    'embedded-postgres',
    'dist',
    'index.js',
  )

  if (!fs.existsSync(entry)) {
    throw new Error(`Bundled PostgreSQL not found at ${entry}`)
  }

  const mod = (await import(pathToFileURL(entry).href)) as { default: EmbeddedPostgresCtor }
  return mod.default
}

/** A cluster that has been initialised has a PG_VERSION file at its root. */
function clusterExists(): boolean {
  return fs.existsSync(path.join(databaseDir(), 'PG_VERSION'))
}

/**
 * Clears a lock file left behind by an unclean shutdown.
 *
 * If the app is force-quit, the machine loses power, or the process tree is
 * killed, `postmaster.pid` survives with a PID that no longer exists. Postgres
 * then refuses to start and the app hangs on boot with no explanation — the user
 * has no way to recover short of deleting files by hand. Detect that case and
 * clear it, but never touch a lock whose process is genuinely alive.
 */
function clearStaleLock(): void {
  const pidFile = path.join(databaseDir(), 'postmaster.pid')
  if (!fs.existsSync(pidFile)) return

  let pid: number | null = null
  try {
    const first = fs.readFileSync(pidFile, 'utf8').split('\n')[0]?.trim()
    const parsed = Number.parseInt(first ?? '', 10)
    pid = Number.isFinite(parsed) ? parsed : null
  } catch {
    pid = null
  }

  if (pid !== null) {
    try {
      // Signal 0 checks for existence without affecting the process.
      process.kill(pid, 0)
      log(`database: lock file held by live process ${pid}; leaving it alone`)
      return
    } catch {
      // ESRCH — no such process, so the lock is stale.
    }
  }

  log(`database: clearing stale lock file (dead pid ${pid ?? 'unknown'})`)
  try {
    fs.rmSync(pidFile, { force: true })
  } catch (err) {
    log(`database: could not remove stale lock: ${(err as Error).message}`)
  }
}

export async function startDatabase(config: AppConfig): Promise<void> {
  if (config.externalDatabaseUrl) {
    log('database: using external URL from config; not starting the bundled cluster')
    return
  }

  const EmbeddedPostgres = await loadEmbeddedPostgres()

  fs.mkdirSync(databaseDir(), { recursive: true })

  instance = new EmbeddedPostgres({
    databaseDir: databaseDir(),
    user: 'lumen',
    password: config.dbPassword,
    port: config.dbPort,
    // Keep the cluster between runs — this is the user's data, not a cache.
    persistent: true,
  })

  if (!clusterExists()) {
    log('database: initialising a new cluster (first run, this takes a moment)')
    await instance.initialise()
  }

  clearStaleLock()

  log(`database: starting on 127.0.0.1:${config.dbPort}`)
  // A bounded wait: without it a refusing cluster leaves the splash spinning
  // forever with nothing to report.
  await withTimeout(
    instance.start(),
    90_000,
    'PostgreSQL did not start within 90 seconds. See the log for its output.',
  )

  try {
    await instance.createDatabase('lumen')
    log('database: created "lumen"')
  } catch {
    // Already present on every run after the first.
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

export async function stopDatabase(): Promise<void> {
  if (!instance) return
  log('database: stopping')
  try {
    await instance.stop()
  } catch (err) {
    log(`database: stop failed: ${(err as Error).message}`)
  }
  instance = null
}

/**
 * Brings the schema in line with the shipped Prisma schema.
 *
 * Run on every boot so an app update that adds columns migrates the existing
 * cluster automatically. Deliberately *without* `--accept-data-loss`: an update
 * that would drop user data should fail loudly rather than silently discard it.
 */
export async function syncSchema(config: AppConfig): Promise<void> {
  const prismaCli = path.join(resourceRoot(), 'node_modules', 'prisma', 'build', 'index.js')

  if (!fs.existsSync(prismaCli)) {
    throw new Error(`Prisma CLI not found at ${prismaCli}`)
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      nodeExecutable(),
      [prismaCli, 'db', 'push', '--schema', prismaSchema(), '--skip-generate'],
      {
        cwd: resourceRoot(),
        env: nodeChildEnv({
          DATABASE_URL: databaseUrl(config),
          // db push consults directUrl for DDL; the bundled cluster is direct.
          DATABASE_URL_UNPOOLED: databaseUrl(config),
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let output = ''
    child.stdout.on('data', (d) => {
      output += d.toString()
      log(`prisma: ${d.toString().trim()}`)
    })
    child.stderr.on('data', (d) => {
      output += d.toString()
      log(`prisma: ${d.toString().trim()}`)
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `Schema sync failed (exit ${code}). This usually means the update needs to change existing data.\n${output.slice(-1200)}`,
        ),
      )
    })
  })
}
