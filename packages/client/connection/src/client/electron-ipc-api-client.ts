/**
 * Electron IPC carrier: `AbstractApiClient` subclass whose transport is a
 * narrow preload bridge (`window.__dshBridge`) instead of HTTP/WebSocket.
 * Unary/respond calls invoke the main process, which dispatches through the
 * exact same shared fetch handler the browser carrier bridges onto its HTTP
 * route; the mux and host streams arrive as frames pushed by the main process
 * over the bridge's event channel.
 *
 * The class depends only on the bridge interface — never on the `electron`
 * module — so the browser package stays clean and the existing
 * `WebApiClient`/`InProcessApiClient`/`FixtureApiClient` family is untouched.
 */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

/** One serialized unary/respond result crossing the IPC boundary. */
export interface IpcFetchResult {
  status: number
  headers: Record<string, string>
  /** The response body as text (JSON envelopes; binary media is not an /api unary shape). */
  body: string
}

/** The event streams the main process pushes to the renderer. */
export type IpcEventStream = 'mux' | 'host'

/**
 * The preload bridge surface this carrier consumes. The preload script
 * implements it over `ipcRenderer.invoke`/`ipcRenderer.on`; tests implement a
 * fake. The payloads are the same JSON shapes the HTTP carrier moves.
 */
export interface DshIpcBridge {
  /**
   * Send one unary/respond request to the main process.
   * @param path - the absolute `/api/...` URL path.
   * @param init - serializable request init (method, headers, body as text).
   * @returns the serialized response.
   */
  invoke(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<IpcFetchResult>
  /**
   * Subscribe to one event stream pushed by the main process.
   * @param stream - which logical stream.
   * @param listener - receives each raw pushed message (the preload bridge
   * passes structured-cloned JSON; wire parsing happens here).
   * @returns unsubscriber.
   */
  onEvent(stream: IpcEventStream, listener: (message: unknown) => void): () => void
}

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type Parser<F> = { parse(value: unknown): F }

/**
 * Electron IPC platform subclass: unary/respond ride the bridge's invoke;
 * mux/host read pushed frames from the bridge's event channel.
 * @param bridge - the preload-exposed IPC bridge.
 */
export class ElectronIpcApiClient extends AbstractApiClient {
  constructor(private readonly bridge: DshIpcBridge) {
    super()
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    // The base class's callUnary/respond always pass a plain headers record
    // and a string body; the method is always POST. The optionality is
    // structural (RequestInit), not a reachable alternative shape.
    const headers = init?.headers as Record<string, string> | undefined
    return this.bridge.invoke(input.pathname + input.search, {
      /* v8 ignore next 5 -- the base carrier always supplies a POST method, headers record, and string body; these arms are structural */
      method: init?.method ?? 'GET',
      ...headers !== undefined ? { headers } : {},
      ...typeof init?.body === 'string' ? { body: init.body } : {},
    }).then(result => new Response(result.body, {
      status: result.status,
      headers: result.headers,
    }))
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readEvents('mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readEvents('host', signal, hostFrameSchema, onOpen)
  }

  /**
   * Read one pushed event stream as an async iterable of narrow frames,
   * honoring the caller's abort signal (the bridge unsubscriber is the
   * transport close).
   */
  private async *readEvents<F extends MuxFrame | HostFrame>(
    stream: IpcEventStream,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleMessage = (raw: unknown): void => {
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(raw)
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed ${stream} frame over IPC:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }
    const handleAbort = (): void => { enqueue({ kind: 'end' }) }
    const unsubscribe = this.bridge.onEvent(stream, handleMessage)
    if (signal.aborted) {
      unsubscribe()
      handleAbort()
    } else {
      signal.addEventListener('abort', handleAbort, { once: true })
      onOpen?.()
    }
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      unsubscribe()
      signal.removeEventListener('abort', handleAbort)
    }
  }
}
