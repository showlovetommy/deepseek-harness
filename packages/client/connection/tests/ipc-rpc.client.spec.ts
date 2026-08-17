/** Electron IPC RPC caller: generic unary channel rides bridge.invoke. */

import { describe, expect, it } from 'vitest'
import { createIpcConnectionRpc } from '../src/client/rpc.ts'
import type { DshIpcBridge } from '../src/client/electron-ipc-api-client.ts'

/** A bridge whose invoke delegates to the given handler (echoes the envelope's rpcId on success). */
function bridge(
  handler: (path: string, body: Record<string, unknown>) => { status: number; body: unknown },
): DshIpcBridge {
  return {
    invoke: async (path, init) => {
      const result = handler(path, JSON.parse(init.body ?? '{}') as Record<string, unknown>)
      return { status: result.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result.body) }
    },
    onEvent: () => () => {},
  }
}

function okResponse(rpcId: string): { type: string; rpcId: string; result: { ok: boolean; value: unknown } } {
  return { type: 'server-response', rpcId, result: { ok: true, value: { items: [] } } }
}

describe('createIpcConnectionRpc', () => {
  it('rides calls through bridge.invoke and returns the parsed result', async () => {
    const paths: string[] = []
    const rpc = createIpcConnectionRpc(bridge((path, body) => {
      paths.push(path)
      return { status: 200, body: okResponse(body.rpcId as string) }
    }))
    const result = await rpc.call('/api', 'dynamicCordisRunner/inventory', { args: {} })
    expect(paths).toEqual(['/api/dynamicCordisRunner/inventory'])
    expect(result).toMatchObject({ ok: true, value: { items: [] } })
  })

  it('throws a transport failure on non-200 status', async () => {
    const rpc = createIpcConnectionRpc(bridge(() => ({ status: 404, body: { nope: true } })))
    await expect(rpc.call('/api', 'dynamicCordisRunner/inventory', { args: {} }))
      .rejects.toThrow('transport failure for /api/dynamicCordisRunner/inventory: HTTP 404')
  })

  it('throws on rpcId mismatch', async () => {
    const rpc = createIpcConnectionRpc(bridge(() => ({ status: 200, body: okResponse('other-rpc') })))
    await expect(rpc.call('/api', 'dynamicCordisRunner/inventory', { args: {} })).rejects.toThrow('rpcId mismatch')
  })
})
