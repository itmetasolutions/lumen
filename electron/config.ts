import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { userDataDir } from './paths'

/**
 * Per-machine configuration, written to userData on first run.
 *
 * The database password and auth secret are generated locally and never shipped
 * in the installer — every install gets its own, so one leaked binary does not
 * expose anyone else's data.
 */

export interface AppConfig {
  dbPassword: string
  dbPort: number
  authSecret: string
  /** Set to point the app at an external Postgres instead of the bundled one. */
  externalDatabaseUrl?: string
  /** Overrides the compiled-in update feed when set. */
  updateFeedUrl?: string
  autoCheckUpdates: boolean
}

const CONFIG_FILE = () => path.join(userDataDir(), 'config.json')

function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

/** Postgres port for the bundled cluster; kept off the default 5432 so it
 *  cannot collide with a Postgres the user already runs. */
const DEFAULT_DB_PORT = 54329

export function loadConfig(): AppConfig {
  const file = CONFIG_FILE()

  let existing: Partial<AppConfig> = {}
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig>
    } catch {
      // A corrupt config must not brick the app — regenerate around it.
      existing = {}
    }
  }

  const config: AppConfig = {
    dbPassword: existing.dbPassword ?? randomSecret(16),
    dbPort: existing.dbPort ?? DEFAULT_DB_PORT,
    authSecret: existing.authSecret ?? randomSecret(32),
    externalDatabaseUrl: existing.externalDatabaseUrl,
    updateFeedUrl: existing.updateFeedUrl,
    autoCheckUpdates: existing.autoCheckUpdates ?? true,
  }

  saveConfig(config)
  return config
}

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(userDataDir(), { recursive: true })
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    // Owner-only where the platform honours it.
    mode: 0o600,
  })
}

export function databaseUrl(config: AppConfig): string {
  if (config.externalDatabaseUrl) return config.externalDatabaseUrl
  const password = encodeURIComponent(config.dbPassword)
  return `postgresql://lumen:${password}@127.0.0.1:${config.dbPort}/lumen?schema=public&connection_limit=10`
}
