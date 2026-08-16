/**
 * Preload script: exposes the narrow `window.__dshBridge` the web client's
 * connection carrier consumes. Unary/respond calls ride `ipcRenderer.invoke`
 * to the main process's `dsh:api` handler; event frames arrive over the
 * main-process-pushed `dsh:event` channel. contextIsolation is on, so the
 * bridge is the only surface the renderer sees.
 *
 * The preload is bundled as CommonJS because sandboxed preload scripts run
 * as plain JavaScript without an ESM context.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { contextBridge, ipcRenderer } from 'electron'

const API_CHANNEL = 'dsh:api'
const EVENT_CHANNEL = 'dsh:event'

/** Structural twin of the connection client half's `IpcEventStream` (see ipc-bridge.ts). */
type IpcEventStream = 'mux' | 'host'

/**
 * Expose the bridge the client connection half detects on the window.
 * Unary/respond invoke the main-process handler; streams subscribe to pushed
 * frames and filter by their stream tag.
 */
export function exposeBridge(): void {
  contextBridge.exposeInMainWorld('__dshBridge', {
    invoke(path: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
      return ipcRenderer.invoke(API_CHANNEL, { path, init })
    },
    onEvent(stream: IpcEventStream, listener: (message: unknown) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        if (typeof payload !== 'object' || payload === null) return
        const { stream: frameStream, message } = payload as { stream?: unknown; message?: unknown }
        if (frameStream !== stream) return
        listener(message)
      }
      ipcRenderer.on(EVENT_CHANNEL, handler)
      return () => { ipcRenderer.removeListener(EVENT_CHANNEL, handler) }
    },
  })
}
