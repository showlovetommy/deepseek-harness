/**
 * Main-process side of the Electron IPC carrier: serves the `dsh:api` unary
 * channel through the host's shared fetch handler (privileged-method fence
 * included) and pumps the two event streams (`mux`, `host`) to the renderer
 * over the `dsh:event` push channel. The push targets one webContents at a
 * time, mirroring the browser carrier's per-connection downlinks.
 *
 * The electron `ipcMain`/`WebContents` surfaces are injected so the bridge
 * logic is testable without an Electron runtime; the app passes the real ones.
 * @module @deepseek-ai/dsh-desktop/ipc-bridge
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionDispatch } from '@deepseek-ai/dsh-client-connection'
import { RpcId, type ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

/** IPC channel names shared with the preload bridge. */
export const API_CHANNEL = 'dsh:api'
export const EVENT_CHANNEL = 'dsh:event'

/**
 * The event streams the main process pushes. Structural twin of the
 * connection client half's `IpcEventStream`; declared locally so this host
 * program never imports the client aggregate's type graph.
 */
type IpcEventStream = 'mux' | 'host'

/** The slice of electron's ipcMain this bridge uses. */
export interface IpcMainSurface {
  handle(channel: string, listener: (event: unknown, request: IpcApiRequest) => Promise<unknown>): void
  removeHandler(channel: string): void
}

/** The slice of electron's WebContents this bridge uses. */
export interface WebContentsSurface {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/** One unary/respond request as carried by the bridge. */
export interface IpcApiRequest {
  path: string
  init: { method: string; headers?: Record<string, string>; body?: string }
}

/** Serialize a fetch Response for the structured-clone IPC round trip. */
async function serializeResponse(response: Response): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  return { status: response.status, headers, body: await response.text() }
}

/**
 * Register the `dsh:api` handler over the host's shared dispatch face.
 * @param ctx - settled host context carrying the Connection service.
 * @param ipcMain - electron's ipcMain (or a test fake).
 * @returns a disposer that removes the handler.
 */
export function installApiHandler(ctx: Context, ipcMain: IpcMainSurface): () => void {
  const handler = async (
    _event: unknown,
    request: IpcApiRequest,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    const connection = ctx.get('connection') as HostConnectionDispatch | undefined
    if (connection === undefined) {
      return { status: 503, headers: {}, body: 'connection unavailable' }
    }
    // Loopback authority so the shared /api trust fence sees the app's own
    // IPC carrier as a trusted local caller: the Host fence binds every
    // request, a fetch Request does not derive Host from its URL until sent,
    // and the fence reads the header — so stamp it explicitly.
    const url = `http://127.0.0.1${request.path}`
    const init: RequestInit = {
      method: request.init.method,
      headers: {
        ...request.init.headers !== undefined ? request.init.headers : {},
        host: '127.0.0.1',
      },
      ...request.init.body !== undefined ? { body: request.init.body } : {},
    }
    const response = await connection.fetchHandler.fetch(new Request(url, init))
    return serializeResponse(response)
  }
  ipcMain.handle(API_CHANNEL, handler)
  return () => { ipcMain.removeHandler(API_CHANNEL) }
}

/**
 * Pump one event stream from the host API to the renderer's webContents.
 * @param ctx - settled host context carrying the apiProxy service.
 * @param target - the renderer webContents receiving the frames.
 * @returns an async disposer that aborts the stream and waits for the pump.
 */
export function installEventPumps(ctx: Context, target: WebContentsSurface): { dispose(): Promise<void> } {
  const api = ctx.get('apiProxy')
  const abort = new AbortController()
  const pumps: Promise<void>[] = []
  if (api !== undefined) {
    pumps.push(pump('mux', api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal), target, abort))
    pumps.push(pump('host', api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal), target, abort))
  }
  return {
    dispose: async () => {
      abort.abort()
      await Promise.all(pumps)
    },
  }
}

async function pump(
  stream: IpcEventStream,
  frames: AsyncIterable<{ rpcId: RpcId; payload: unknown }>,
  target: WebContentsSurface,
  abort: AbortController,
): Promise<void> {
  try {
    for await (const frame of frames) {
      if (target.isDestroyed()) break
      const message: ServerRequest = {
        type: 'server-request',
        rpcId: frame.rpcId,
        method: (frame.payload as { type: string }).type,
        payload: frame.payload,
      }
      target.send(EVENT_CHANNEL, { stream, message })
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      const failure: ServerRequest = {
        type: 'server-request',
        rpcId: RpcId(randomUUID()),
        method: 'stream/error',
        payload: { type: 'stream/error', error: { code: 'internal', message: String(error), details: {} } },
      }
      if (!target.isDestroyed()) target.send(EVENT_CHANNEL, { stream, message: failure })
    }
  }
}
