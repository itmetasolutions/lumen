import { contextBridge, ipcRenderer } from 'electron'

/**
 * Dedicated preload for the splash window so it never needs nodeIntegration.
 * The splash only renders local, trusted content, but keeping the whole app
 * free of nodeIntegration means there is no exception to reason about later.
 */
contextBridge.exposeInMainWorld('splash', {
  onStage: (handler: (payload: { stage: string; hint?: string }) => void) => {
    ipcRenderer.on('boot:stage', (_e, payload) => handler(payload))
  },
  onError: (handler: (payload: { message: string }) => void) => {
    ipcRenderer.on('boot:error', (_e, payload) => handler(payload))
  },
})
