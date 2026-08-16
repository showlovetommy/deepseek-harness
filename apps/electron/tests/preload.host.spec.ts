/**
 * Preload behavior: importing the preload module exposes the `__dshBridge`
 * (the module-level call the shell relies on), and the bridge's invoke and
 * onEvent arms speak the IPC channels the main-process bridge implements.
 */

import { describe, expect, it, vi } from 'vitest'

const { exposed, ipcListeners } = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  ipcListeners: new Map<string, Array<(event: unknown, payload: unknown) => void>>(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => { exposed.set(key, value) },
  },
  ipcRenderer: {
    invoke: vi.fn(async () => ({ status: 200, body: '{}' })),
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      const bucket = ipcListeners.get(channel) ?? []
      bucket.push(listener)
      ipcListeners.set(channel, bucket)
    },
    removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      const bucket = ipcListeners.get(channel) ?? []
      ipcListeners.set(channel, bucket.filter(candidate => candidate !== listener))
    },
  },
}))

// Module-level side effect: the preload must expose the bridge on import.
import '../src/preload.ts'
import { ipcRenderer } from 'electron'

/** The bridge as captured by the mocked contextBridge. */
function bridge(): {
  invoke(path: string, init: unknown): Promise<unknown>
  onEvent(stream: string, listener: (message: unknown) => void): () => void
} {
  const value = exposed.get('__dshBridge')
  if (typeof value !== 'object' || value === null) throw new Error('__dshBridge was not exposed')
  return value as ReturnType<typeof bridge>
}

describe('preload bridge', () => {
  it('exposes __dshBridge on import', () => {
    expect(exposed.has('__dshBridge')).toBe(true)
  })

  it('rides invoke onto the dsh:api channel', async () => {
    const invoke = ipcRenderer.invoke as ReturnType<typeof vi.fn>
    invoke.mockClear()
    const result = await bridge().invoke('/api/session.list', { method: 'POST', body: '{}' })
    expect(invoke).toHaveBeenCalledWith('dsh:api', { path: '/api/session.list', init: { method: 'POST', body: '{}' } })
    expect(result).toMatchObject({ status: 200 })
  })

  it('filters pushed event frames by stream and unsubscribes', () => {
    const received: unknown[] = []
    const unsubscribe = bridge().onEvent('mux', (message) => { received.push(message) })
    const handler = ipcListeners.get('dsh:event')!.at(-1)!
    handler(null, { stream: 'host', message: { ignored: true } })
    handler(null, { stream: 'mux', message: { kept: true } })
    handler(null, 'not an object')
    expect(received).toEqual([{ kept: true }])
    unsubscribe()
    expect(ipcListeners.get('dsh:event')).toHaveLength(0)
  })
})
