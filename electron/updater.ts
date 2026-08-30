import { app, dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { log } from './log'

/**
 * Auto-update via GitHub Releases.
 *
 * The feed is declared in package.json → build.publish, so electron-updater
 * resolves it without any code. `config.updateFeedUrl` overrides it for people
 * hosting their own builds.
 *
 * Updates download in the background and install on quit: interrupting someone
 * mid-discovery to restart would lose running jobs.
 */

let checking = false

/** Only the feed override is needed, so both the admin and agent builds fit. */
export interface UpdaterConfig {
  updateFeedUrl?: string
  /**
   * Which update feed to read.
   *
   * The admin app and the agent app publish to one GitHub repository, and
   * electron-updater looks for `latest.yml` unless told otherwise. Left at the
   * default, the two feeds would collide in the same release and each app would
   * offer the other's installer as its own update — an agent's 97 MB client
   * quietly replaced by the 300 MB server build. The agent sets 'agent', which
   * matches `publish.channel` in electron-builder.agent.json.
   */
  channel?: string
}

export function initUpdater(
  config: UpdaterConfig,
  getWindow: () => BrowserWindow | null,
): void {
  autoUpdater.autoDownload = true
  // We install on quit ourselves, so the user is never restarted unexpectedly.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m: unknown) => log(`updater: ${String(m)}`),
    warn: (m: unknown) => log(`updater(warn): ${String(m)}`),
    error: (m: unknown) => log(`updater(error): ${String(m)}`),
    debug: () => {},
  }

  if (config.channel) {
    autoUpdater.channel = config.channel
    log(`updater: reading the "${config.channel}" channel`)
  }

  if (config.updateFeedUrl) {
    log(`updater: using custom feed ${config.updateFeedUrl}`)
    autoUpdater.setFeedURL({ provider: 'generic', url: config.updateFeedUrl })
  }

  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload)
  }

  autoUpdater.on('checking-for-update', () => send('update:status', { state: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    log(`updater: version ${info.version} available`)
    send('update:status', { state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    send('update:status', { state: 'current', version: app.getVersion() })
  })

  autoUpdater.on('download-progress', (p) => {
    send('update:status', { state: 'downloading', percent: Math.round(p.percent) })
  })

  autoUpdater.on('update-downloaded', async (info) => {
    log(`updater: ${info.version} downloaded`)
    send('update:status', { state: 'ready', version: info.version })

    const window = getWindow()
    const result = await dialog.showMessageBox(window ?? undefined!, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Version ${info.version} is ready to install.`,
      detail:
        'Restarting takes a few seconds. Any running discovery or audit jobs resume automatically afterwards, because they are stored in the database rather than in memory.',
    })

    if (result.response === 0) {
      // quitAndInstall tears down the app; child processes are stopped by the
      // before-quit handler in main.ts.
      setImmediate(() => autoUpdater.quitAndInstall())
    }
  })

  autoUpdater.on('error', (err) => {
    log(`updater: ${err.message}`)
    send('update:status', { state: 'error', message: err.message })
  })
}

export async function checkForUpdates(silent = true): Promise<void> {
  if (!app.isPackaged) {
    log('updater: skipped (not a packaged build)')
    return
  }
  if (checking) return

  checking = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    log(`updater: check failed: ${(err as Error).message}`)
    if (!silent) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Could not check for updates',
        message: (err as Error).message,
      })
    }
  } finally {
    checking = false
  }
}
