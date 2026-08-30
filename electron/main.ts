import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron'
import path from 'node:path'
import { ensureDirs, logFile, userDataDir } from './paths'
import { loadConfig } from './config'
import { startDatabase, stopDatabase, syncSchema } from './database'
import { startServer, startWorker, stopAll, setUnexpectedExitHandler } from './server'
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
  const { url, port } = await startServer(config)

  stage('Starting the background worker', 'Discovery, audits and exports run here.')
  startWorker(config, port)

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
  Menu.setApplicationMenu(buildMenu())
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

function buildMenu(): Menu {
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
