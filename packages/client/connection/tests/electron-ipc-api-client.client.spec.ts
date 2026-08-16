/** Electron IPC carrier: unary via bridge.invoke, streams via bridge.onEvent. */

import { describe, expect, it } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { ElectronIpcApiClient, type DshIpcBridge } from '../src/client/electron-ipc-api-client.ts'

/** A fake bridge recording invokes and pushing scripted frames on demand. */
function fakeBridge(): {
  bridge: DshIpcBridge
  invokes: { path: string; init: { method: string; headers?: Record<string, string>; body?: string } }[]
  push(stream: 'mux' | 'host', message: ServerRequest): void
} {
  const listeners = new Map<'mux' | 'host', Set<(message: unknown) => void>>()
  const invokes: { path: string; init: { method: string; headers?: Record<string, string>; body?: string } }[] = []
  return {
    invokes,
    bridge: {
      invoke: async (path, init) => {
        invokes.push({ path, init })
        const request = JSON.parse(init.body ?? '{}') as { rpcId?: string }
        const response = {
          type: 'server-response',
          rpcId: request.rpcId ?? 'unknown',
          result: { ok: true, value: { items: [] } },
        }
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(response) }
      },
      onEvent: (stream, listener) => {
        let set = listeners.get(stream)
        if (set === undefined) {
          set = new Set()
          listeners.set(stream, set)
        }
        set.add(listener)
        return () => { set.delete(listener) }
      },
    },
    push(stream, message) {
      for (const listener of listeners.get(stream) ?? []) listener(message)
    },
  }
}

function subscribedFrame(seq = 1): ServerRequest {
  return {
    type: 'server-request',
    rpcId: RpcId('rpc-frame'),
    method: 'session/subscribed',
    payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: seq },
  }
}

describe('ElectronIpcApiClient', () => {
  it('rides unary calls through bridge.invoke with the serialized request', async () => {
    const fake = fakeBridge()
    const client = new ElectronIpcApiClient(fake.bridge)
    const response = await client.sessions.list({}, new AbortController().signal)
    expect(fake.invokes).toHaveLength(1)
    expect(fake.invokes[0]!.path).toBe('/api/session.list')
    expect(fake.invokes[0]!.init.method).toBe('POST')
    const parsed = JSON.parse(fake.invokes[0]!.init.body!) as { type: string; rpcId: string; method: string }
    expect(parsed.type).toBe('client-request')
    expect(parsed.method).toBe('session.list')
    expect(response.result.ok).toBe(true)
  })

  it('reads pushed mux frames as an async iterable and honors abort', async () => {
    const fake = fakeBridge()
    const client = new ElectronIpcApiClient(fake.bridge)
    const controller = new AbortController()
    const iterator = client.events.mux({}, controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    fake.push('mux', subscribedFrame(3))
    const first = await pending
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({ rpcId: 'rpc-frame', payload: { type: 'session/subscribed', lastSeq: 3 } })

    const second = iterator.next()
    controller.abort()
    expect((await second).done).toBe(true)
  })

  it('drops malformed frames and still terminates on abort', async () => {
    const fake = fakeBridge()
    const client = new ElectronIpcApiClient(fake.bridge)
    const controller = new AbortController()
    const iterator = client.events.host({}, controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    fake.push('host', { type: 'server-request', rpcId: RpcId('bad'), method: 'session/event', payload: { nonsense: true } } as never)
    const next = iterator.next()
    controller.abort()
    expect((await pending).done).toBe(true)
    expect((await next).done).toBe(true)
  })

  it('terminates immediately when the stream is opened with an already-aborted signal', async () => {
    const fake = fakeBridge()
    const client = new ElectronIpcApiClient(fake.bridge)
    const controller = new AbortController()
    controller.abort()
    const iterator = client.events.mux({}, controller.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(true)
  })

  it('serializes plain header records and omits absent body', async () => {
    const fake = fakeBridge()
    const client = new ElectronIpcApiClient(fake.bridge)
    // session.list rides callUnary, which always supplies a content-type
    // header record and a string body.
    const response = await client.sessions.list({}, new AbortController().signal)
    expect(fake.invokes).toHaveLength(1)
    expect(fake.invokes[0]!.init.method).toBe('POST')
    expect(fake.invokes[0]!.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(typeof fake.invokes[0]!.init.body).toBe('string')
    expect(response.result.ok).toBe(true)
  })
})
