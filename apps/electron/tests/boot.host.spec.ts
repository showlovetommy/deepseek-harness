/**
 * Desktop host boot smoke: boots the real desktop composition — the
 * dsh-base bundle patch plus the desktop patch (web rows minus the
 * webserver-dependent ones) over the empty profile root through the vendored
 * Loader — and asserts the tree settles with the clientModules service (the
 * browser roster + boot graph), WITHOUT a webServer (the Electron shell
 * serves dist and bundles over dsh:// itself), and with the IPC carrier's
 * dispatch face (the Connection service's shared fetch handler) callable.
 */

import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
// Empty type import carries the clientModules Context merge.
import type {} from '@deepseek-ai/dsh-client-modules'
import { healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { installApiHandler, type IpcApiRequest, type IpcMainSurface } from '../src/ipc-bridge.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The dsh installation anchor: this app's package.json (the desktop patch rows resolve through its dependencies). */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** Boot the desktop composition (base + desktop patches) over an isolated home. */
async function bootDesktop(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-desktop-boot-'))
  const harnessHome = join(root, '.dsh-home')
  healProfilesModuleFallback(INSTALL_ANCHOR, harnessHome)
  const profileDir = join(harnessHome, 'profiles', 'desktop')
  await mkdir(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')

  const require = createRequire(import.meta.url)
  const basePatches = loadOverlayPatches('dsh-desktop', require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'))
  const desktopPatches = loadOverlayPatches(
    'dsh-desktop',
    fileURLToPath(new URL('../config/cordis.patch.yml', import.meta.url)),
  )

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(rootConfig)).href + '/'
  ctx.provide('dshHomePath', dshHomePath)
  provideCmdline(ctx, {
    args: [],
    exit: (code) => {
      throw new Error(`dsh-desktop boot smoke: the desktop app requested exit ${String(code)}`)
    },
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(rootConfig).href, patches: [...basePatches, ...desktopPatches] },
  })
  await ctx.loader.await()
  return ctx
}

describe('desktop host boot', () => {
  it('settles the base + desktop composition with clientModules and no webServer', async () => {
    const ctx = await bootDesktop()
    try {
      // The browser roster + graph service mounted without a webserver.
      const clientModules = ctx.get('clientModules')
      expect(clientModules).toBeDefined()
      expect(clientModules!.graph().entries.length).toBeGreaterThan(0)
      // The desktop composition deliberately omits the HTTP carrier.
      expect(ctx.get('webServer')).toBeUndefined()
      // M1: the IPC carrier's dispatch face is present on the Connection service.
      const connection = ctx.get('connection') as { fetchHandler?: { fetch(request: Request): Promise<Response> } } | undefined
      expect(connection?.fetchHandler).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('dispatches a real session.list envelope through the IPC handler', async () => {
    const ctx = await bootDesktop()
    const handlers = new Map<string, (event: unknown, request: IpcApiRequest) => Promise<unknown>>()
    const ipcMain: IpcMainSurface = {
      handle: (channel, listener) => { handlers.set(channel, listener) },
      removeHandler: (channel) => { handlers.delete(channel) },
    }
    const remove = installApiHandler(ctx, ipcMain)
    try {
      const listener = handlers.get('dsh:api')
      expect(listener).toBeDefined()
      const result = await listener!(null, {
        path: '/api/session.list',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'boot-smoke-1',
            method: 'session.list',
            payload: {},
          }),
        },
      })
      expect(result).toMatchObject({ status: 200 })
      const body = (result as { body?: unknown }).body
      expect(typeof body).toBe('string')
      const envelope = JSON.parse(body as string) as { type: string; rpcId: string; result: { ok: boolean } }
      expect(envelope.type).toBe('server-response')
      expect(envelope.rpcId).toBe('boot-smoke-1')
      expect(envelope.result.ok).toBe(true)
    } finally {
      remove()
      await ctx.fiber.dispose()
    }
  })
})
