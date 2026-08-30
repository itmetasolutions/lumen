import { app, BrowserWindow, dialog, ipcMain, Menu, net, shell } from 'electron'
import path from 'node:path'
import {
  isOwnServer,
  loadAgentConfig,
  normaliseServerUrl,
  saveAgentConfig,
  type AgentConfig,
} from './agent-config'
import { initUpdater, checkForUpdates } from './updater'
import { log } from './log'

/**
 * Lumen Agent — the calling app.
 *
 * A deliberately thin client. It opens the team's Lumen server at `/agent` and
 * gets out of the way: no database, no background worker, no discovery. The
 * whole desktop layer exists for three reasons a browser tab does not cover —
 * it remembers the server address, it updates itself, and it keeps the agent in
 * one window all shift rather than in a tab that gets closed by accident.
 */

let window: BrowserWindow | null = null
let setupWindow: BrowserWindow | null = null
let config: AgentConfig = { serverUrl: null, autoCheckUpdates: true }

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  const win = window ?? setupWindow
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

/**
 * Checks the address actually answers before committing to it.
 *
 * A typo in the server address would otherwise present as a blank window with
 * no explanation. Asking the server to identify itself first means the setup
 * screen can say what is wrong while the agent is still looking at the field.
 */
async function probeServer(serverUrl: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const request = net.request({ method: 'GET', url: `${serverUrl}/login` })
    const timer = setTimeout(() => {
      request.abort()
      resolve({ ok: false, error: 'The server did not respond within 10 seconds.' })
    }, 10_000)

    request.on('response', (response) => {
      clearTimeout(timer)
      // Any HTML response from /login means a Lumen server is listening. A 404
      // means something else is on that address.
      if (response.statusCode >= 200 && response.statusCode < 400) {
        resolve({ ok: true })
      } else if (response.statusCode === 404) {
        resolve({ ok: false, error: 'Something is running there, but it is not Lumen.' })
      } else {
        resolve({ ok: false, error: `The server answered with ${response.statusCode}.` })
      }
      response.on('data', () => {})
      response.on('end', () => {})
    })

    request.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        error: `Could not reach that address. ${err.message}`,
      })
    })

    request.end()
  })
}

function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 480,
    resizable: false,
    title: 'Lumen Agent — Setup',
    backgroundColor: '#0f1523',
    webPreferences: {
      preload: path.join(__dirname, 'agent-setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  Menu.setApplicationMenu(null)
  void win.loadFile(path.join(__dirname, 'agent-setup.html'))
  return win
}

function createMainWindow(serverUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: config.window?.width ?? 1280,
    height: config.window?.height ?? 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#f7f9fc',
    title: 'Lumen Agent',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Remember the size the agent chose; they work in this window all day.
  win.on('close', () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
    const [width, height] = win.getSize()
    config = { ...config, window: { width, height } }
    saveAgentConfig(config)
  })

  // Anything not on the team's own server opens in the system browser rather
  // than replacing the app the agent is working in.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwnServer(url, serverUrl)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl) => {
    // -3 is an aborted load, which happens routinely during client navigation.
    if (errorCode === -3) return
    log(`agent: failed to load ${failedUrl}: ${errorDescription}`)
    void showConnectionFailure(win, serverUrl, errorDescription)
  })

  void win.loadURL(`${serverUrl}/agent`)
  return win
}

async function showConnectionFailure(
  win: BrowserWindow,
  serverUrl: string,
  detail: string,
): Promise<void> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Cannot reach Lumen',
    message: `Lumen is not answering at ${serverUrl}.`,
    detail:
      `${detail}\n\n` +
      'The server may be off, or your computer may have lost the network. ' +
      'Ask your supervisor whether Lumen is running.',
    buttons: ['Try again', 'Change server address', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  })

  if (response === 0) {
    void win.loadURL(`${serverUrl}/agent`)
  } else if (response === 1) {
    win.destroy()
    window = null
    setupWindow = createSetupWindow()
  } else {
    app.quit()
  }
}

function start(serverUrl: string): void {
  setupWindow?.close()
  setupWindow = null
  window = createMainWindow(serverUrl)

  if (config.autoCheckUpdates) {
    initUpdater({ channel: 'agent' }, () => window)
  }
}

app.whenReady().then(async () => {
  config = loadAgentConfig()
  log(`agent starting — server ${config.serverUrl ?? 'not configured'}`)

  ipcMain.handle('agent:get-config', () => ({
    serverUrl: config.serverUrl,
    version: app.getVersion(),
  }))

  ipcMain.handle('agent:set-server', async (_event, raw: string) => {
    const serverUrl = normaliseServerUrl(raw)
    if (!serverUrl) {
      return { ok: false, error: 'That does not look like a web address.' }
    }

    const probe = await probeServer(serverUrl)
    if (!probe.ok) return probe

    config = { ...config, serverUrl }
    saveAgentConfig(config)
    start(serverUrl)
    return { ok: true, serverUrl }
  })

  ipcMain.handle('agent:check-updates', () => checkForUpdates())

  if (config.serverUrl) {
    // Confirm the remembered address still works before showing a blank window.
    const probe = await probeServer(config.serverUrl)
    if (probe.ok) {
      start(config.serverUrl)
      return
    }
    log(`agent: remembered server unreachable — ${probe.error}`)
  }

  setupWindow = createSetupWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (config.serverUrl) start(config.serverUrl)
    else setupWindow = createSetupWindow()
  }
})
