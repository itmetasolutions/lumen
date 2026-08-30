import { contextBridge, ipcRenderer } from 'electron'

/**
 * The only bridge between the web app and Electron.
 *
 * `contextIsolation` is on and `nodeIntegration` off, so the renderer gets this
 * explicit, minimal surface and nothing else — the app loads a local server, but
 * it also renders third-party content (audit screenshots) and must not be able
 * to reach Node.
 */

export interface UpdateStatus {
  state: 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error'
  version?: string
  percent?: number
  message?: string
}

contextBridge.exposeInMainWorld('lumen', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  openLogFolder: () => ipcRenderer.invoke('app:open-logs'),
  onUpdateStatus: (handler: (status: UpdateStatus) => void) => {
    const listener = (_e: unknown, status: UpdateStatus) => handler(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
})
