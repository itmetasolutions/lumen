import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload for the first-run setup window.
 *
 * Exposes exactly two calls and nothing else: read the remembered address, and
 * try a new one. The setup page renders local trusted content, but keeping the
 * surface this small means there is no privileged API to reason about if that
 * ever stops being true.
 */
contextBridge.exposeInMainWorld('agentSetup', {
  getConfig: (): Promise<{ serverUrl: string | null; version: string }> =>
    ipcRenderer.invoke('agent:get-config'),
  setServer: (url: string): Promise<{ ok: boolean; error?: string; serverUrl?: string }> =>
    ipcRenderer.invoke('agent:set-server', url),
})
