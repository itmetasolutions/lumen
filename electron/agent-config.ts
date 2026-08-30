import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { isOwnServer, normaliseServerUrl } from './server-url'

// Re-exported so callers keep importing their config helpers from one place.
export { isOwnServer, normaliseServerUrl }

/**
 * Agent-app configuration.
 *
 * The agent build is a *client*. It has no database, no worker and no server of
 * its own — it points at the Lumen server the team already runs, because agents
 * and their supervisor have to be looking at the same leads. Bundling Postgres
 * here, as the admin build does, would give every agent their own private copy
 * of the data, which is the opposite of what a shared queue means.
 *
 * So the only thing stored on the agent's machine is the address of that server.
 */

export interface AgentConfig {
  /** Origin of the Lumen server, e.g. https://lumen.example.com or http://192.168.1.10:3210 */
  serverUrl: string | null
  autoCheckUpdates: boolean
  /** Remembered window size, so the app opens where it was left. */
  window?: { width: number; height: number }
}

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'agent-config.json')

export function loadAgentConfig(): AgentConfig {
  const file = CONFIG_FILE()
  let existing: Partial<AgentConfig> = {}

  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AgentConfig>
    } catch {
      // A corrupt file must not lock the agent out of their own app; they will
      // be asked for the server address again, which is recoverable.
      existing = {}
    }
  }

  return {
    serverUrl: normaliseServerUrl(existing.serverUrl ?? null),
    autoCheckUpdates: existing.autoCheckUpdates ?? true,
    window: existing.window,
  }
}

export function saveAgentConfig(config: AgentConfig): void {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
}
