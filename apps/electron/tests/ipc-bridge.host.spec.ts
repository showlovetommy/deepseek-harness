/** Main-process IPC bridge: unary handler over the shared dispatch face, event pumps to a webContents. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  API_CHANNEL, EVENT_CHANNEL, installApiHandler, installEventPumps,
  type IpcApiRequest, type IpcMainSurface, type WebContentsSurface,
} from '../src/ipc-bridge.ts'

function fakeIpcMain(): { ipcMain: IpcMainSurface; handlers: Map<string, (event: unknown, request: IpcApiRequest) => Promise<unknown>> } {
  const handlers = new Map<string, (event: unknown, request: IpcApiRequest) => Promise<unknown>>()
  return {
    handlers,
    ipcMain: {
      handle: (channel, listener) => { handlers.set(channel, listener) },
      removeHandler: (channel) => { handlers.delete(channel) },
    },
  }
}

function fakeWebContents(): { surface: WebContentsSurface; sent: { channel: string; args: unknown[] }[] } {
  const sent: { channel: string; args: unknown[] }[] = []
  return {
    sent,
    surface: {
      isDestroyed: () => false,
      send: (channel, ...args) => { sent.push({ channel, args }) },
    },
  }
}

/** Narrow an unknown pushed payload to its stream tag, or undefined. */
function streamOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const stream = (payload as { stream?: unknown }).stream
  return typeof stream === 'string' ? stream : undefined
}

/** Narrow an unknown pushed payload to its message rpcId, or undefined. */
function rpcIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const message = (payload as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const rpcId = (message as { rpcId?: unknown }).rpcId
  return typeof rpcId === 'string' ? rpcId : undefined
}

/** A settled ctx carrying the connection dispatch and an apiProxy with scripted streams. */
function fakeContext(): { ctx: Context; fetchCalls: Request[] } {
  const ctx = new Context()
  const fetchCalls: Request[] = []
  ctx.provide('connection', {
    rpc: { handle: () => () => Promise.resolve(), intercept: () => () => Promise.resolve() },
    fetchHandler: {
      fetch: (request: Request) => {
        fetchCalls.push(request)
        return Promise.resolve(new Response('{"result":{"ok":true,"value":{}}}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      },
    },
  })
  ctx.provide('apiProxy', {
    events: {
      mux: function* () {
        yield { rpcId: RpcId('mux-1'), payload: { type: 'session/event', sessionId: 's1' } }
      },
      host: function* () {
        yield { rpcId: RpcId('host-1'), payload: { type: 'host/agent-error', sessionId: 's1' } }
      },
    },
  })
  return { ctx, fetchCalls }
}

describe('installApiHandler', () => {
  it('dispatches bridge requests through the shared fetch handler and serializes the response', async () => {
    const fake = fakeContext()
    const ipc = fakeIpcMain()
    const remove = installApiHandler(fake.ctx, ipc.ipcMain)
    const listener = ipc.handlers.get(API_CHANNEL)
    expect(listener).toBeDefined()
    const request: IpcApiRequest = {
      path: '/api/session.list',
      init: { method: 'POST', body: '{"type":"client-request"}' },
    }
    const result = await listener!(null, request)
    expect(fake.fetchCalls).toHaveLength(1)
    expect(fake.fetchCalls[0]!.url).toBe('http://dsh.internal/api/session.list')
    expect(result).toMatchObject({ status: 200, headers: { 'content-type': 'application/json' } })
    const body = (result as { body?: unknown }).body
    expect(typeof body).toBe('string')
    expect(body).toContain('"ok":true')
    remove()
    expect(ipc.handlers.has(API_CHANNEL)).toBe(false)
  })

  it('answers 503 when the connection service is absent', async () => {
    const ctx = new Context()
    const ipc = fakeIpcMain()
    const remove = installApiHandler(ctx, ipc.ipcMain)
    const listener = ipc.handlers.get(API_CHANNEL)
    expect(listener).toBeDefined()
    const request: IpcApiRequest = { path: '/api/session.list', init: { method: 'POST' } }
    const result = await listener!(null, request)
    expect(result).toMatchObject({ status: 503 })
    remove()
  })
})

describe('installEventPumps', () => {
  it('pushes mux and host frames to the webContents and stops on dispose', async () => {
    const fake = fakeContext()
    const target = fakeWebContents()
    const pumps = installEventPumps(fake.ctx, target.surface)
    await new Promise(resolve => setTimeout(resolve, 10))
    await pumps.dispose()
    const mux = target.sent.filter(entry => streamOf(entry.args[0]) === 'mux')
    const host = target.sent.filter(entry => streamOf(entry.args[0]) === 'host')
    expect(mux).toHaveLength(1)
    expect(mux[0]!.channel).toBe(EVENT_CHANNEL)
    expect(rpcIdOf(mux[0]!.args[0])).toBe('mux-1')
    expect(host).toHaveLength(1)
    expect(rpcIdOf(host[0]!.args[0])).toBe('host-1')
  })
})
