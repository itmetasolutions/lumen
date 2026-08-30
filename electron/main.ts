import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron'
import path from 'node:path'
import { ensureDirs, logFile, userDataDir } from './paths'
import { loadConfig, saveConfig, type AppConfig } from './config'
import { startDatabase, stopDatabase, syncSchema } from './database'
import {
  startServer, startWorker, stopAll, setUnexpectedExitHandler, localAddresses,
} from './server'
import { initUpdater, checkForUpdates } from './updater'
import { log, recentLog } from './log'

/**
 * Desktop entry point.
 *
 * Boot order matters and each step depends on the last: the database must be up
 * before the schema can be synced, the schema must exist before the server can
 * serve a page, and the server must be answering before a window points at it.
 * Each stage reports to the splash so a slow first run looks like progress
 * rather than a hang — initialising the Postgres cluster genuinely takes a while.
 */

let splashWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let isQuitting = false
let runtime: { url: string; lanUrls: string[] } | null = null
let appConfig: AppConfig | null = null

// Only one copy may own the database directory.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 260,
    frame: false,
    resizable: false,
    show: true,
    backgroundColor: '#0f1523',
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  void win.loadFile(path.join(__dirname, 'splash.html'))
  return win
}

function stage(name: string, hint?: string): void {
  log(`boot: ${name}${hint ? ` — ${hint}` : ''}`)
  splashWindow?.webContents.send('boot:stage', { stage: name, hint })
}

function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f9fc',
    title: 'Lumen',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The app renders third-party audit screenshots; keep the renderer sandboxed.
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
    splashWindow?.close()
    splashWindow = null
  })

  // Anything that is not our local server opens in the real browser — the app
  // links out to audited websites, provider terms and source URLs.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })

  void win.loadURL(url)
  return win
}

async function boot(): Promise<void> {
  ensureDirs()
  const config = loadConfig()

  stage('Preparing', userDataDir())

  stage(
    'Starting the database',
    'First run initialises a local PostgreSQL cluster — this can take a minute.',
  )
  await startDatabase(config)

  stage('Updating the database schema')
  await syncSchema(config)

  stage('Starting the application')
  const { url, port, lanUrls } = await startServer(config)

  stage('Starting the background worker', 'Discovery, audits and exports run here.')
  startWorker(config, port)

  runtime = { url, lanUrls }
  appConfig = config
  Menu.setApplicationMenu(buildMenu())

  mainWindow = createMainWindow(url)

  initUpdater(config, () => mainWindow)
  if (config.autoCheckUpdates) {
    // Delayed so it never competes with first paint.
    setTimeout(() => void checkForUpdates(true), 8_000)
  }
}

function reportBootFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  log(`boot: FAILED — ${message}`)

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.setSize(560, 420)
    splashWindow.center()
    splashWindow.webContents.send('boot:error', {
      message: `${message}\n\nLog: ${logFile()}`,
    })
  } else {
    void dialog.showMessageBox({
      type: 'error',
      title: 'Lumen could not start',
      message,
      detail: `Log: ${logFile()}`,
    })
  }
}

app.whenReady().then(async () => {
  splashWindow = createSplash()

  setUnexpectedExitHandler((message) => {
    if (isQuitting) return
    void dialog.showMessageBox({
      type: 'error',
      title: 'Lumen stopped',
      message,
      detail: `Restart the app. Log: ${logFile()}`,
    })
  })

  try {
    await boot()
  } catch (err) {
    reportBootFailure(err)
  }
})

app.on('window-all-closed', () => {
  // On Windows and Linux, closing the window ends the session.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (isQuitting) return
  // Child processes and the database need an orderly shutdown; an abrupt exit
  // can leave the Postgres cluster needing recovery on next launch.
  event.preventDefault()
  isQuitting = true

  log('shutdown: stopping child processes')
  await stopAll()
  await stopDatabase()
  log('shutdown: complete')

  app.exit(0)
})

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('update:check', async () => {
  await checkForUpdates(false)
  return app.getVersion()
})

ipcMain.handle('app:open-logs', async () => {
  await shell.openPath(userDataDir())
  return userDataDir()
})

/**
 * Turning network sharing on or off.
 *
 * The server binds its interface at startup, so this cannot take effect until
 * the app restarts — and saying so up front is better than a switch that
 * appears to do nothing. Sharing is a real exposure decision, so the dialog
 * states what it means rather than just asking for confirmation.
 */
async function toggleSharing(): Promise<void> {
  if (!appConfig) return
  const turningOn = !appConfig.shareOnNetwork

  const { response } = await dialog.showMessageBox(mainWindow ?? undefined!, {
    type: 'question',
    title: turningOn ? 'Let your team connect' : 'Stop sharing',
    message: turningOn
      ? 'Allow other computers on your network to reach this Lumen?'
      : 'Stop other computers from reaching this Lumen?',
    detail: turningOn
      ? [
          'Your agents need this to sign in from the Lumen Agent app.',
          `Anything that can reach this computer on port ${appConfig.sharePort} will be able ` +
            'to open the sign-in page. They still need an account you created before they ' +
            'can see anything. Do not turn this on over a public or untrusted network.',
          'Lumen needs to restart for this to take effect.',
        ].join('\n\n')
      : [
          'Agents will no longer be able to connect from their own machines.',
          'Lumen needs to restart for this to take effect.',
        ].join('\n\n'),
    buttons: [turningOn ? 'Turn on and restart' : 'Turn off and restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return

  appConfig = { ...appConfig, shareOnNetwork: turningOn }
  saveConfig(appConfig)
  app.relaunch()
  app.quit()
}

/** Shows the addresses to read out to agents, and puts one on the clipboard. */
async function showTeamAddress(): Promise<void> {
  const { clipboard } = require('electron') as typeof import('electron')
  const urls = runtime?.lanUrls.length
    ? runtime.lanUrls
    : appConfig?.shareOnNetwork
      ? localAddresses(appConfig.sharePort)
      : []

  if (urls.length === 0) {
    await dialog.showMessageBox(mainWindow ?? undefined!, {
      type: 'info',
      title: 'Not shared',
      message: 'This Lumen is not reachable from other computers.',
      detail:
        'Turn on "Let my team connect" first. Until then, only this computer can open it.',
    })
    return
  }

  const { response } = await dialog.showMessageBox(mainWindow ?? undefined!, {
    type: 'info',
    title: 'Your team address',
    message: 'Give your agents this address:',
    detail: [
      urls.join('\n'),
      'They enter it once, the first time they open the Lumen Agent app.',
      // Several interfaces means several addresses, only one of which will
      // route to the agents' machines. Say which to pick rather than listing
      // them without explanation.
      ...(urls.length > 1
        ? [
            'More than one is listed because this computer is on several ' +
              'networks. Use the one on the same network as your agents.',
          ]
        : []),
    ].join('\n\n'),
    buttons: ['Copy address', 'Close'],
    defaultId: 0,
  })

  if (response === 0) clipboard.writeText(urls[0]!)
}

function buildMenu(): Menu {
  const sharing = appConfig?.shareOnNetwork ?? false

  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Team',
      submenu: [
        {
          label: 'Let my team connect',
          type: 'checkbox',
          checked: sharing,
          click: () => void toggleSharing(),
        },
        {
          label: 'Show address for agents…',
          enabled: sharing,
          click: () => void showTeamAddress(),
        },
        { type: 'separator' },
        {
          label: sharing
            ? `Sharing on port ${appConfig?.sharePort ?? ''}`
            : 'Not shared — this computer only',
          enabled: false,
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => void checkForUpdates(false),
        },
        {
          label: 'Open Data & Logs Folder',
          click: () => void shell.openPath(userDataDir()),
        },
        {
          label: 'Copy Startup Log',
          click: () => {
            const { clipboard } = require('electron') as typeof import('electron')
            clipboard.writeText(recentLog())
          },
        },
        { type: 'separator' },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ])
}
