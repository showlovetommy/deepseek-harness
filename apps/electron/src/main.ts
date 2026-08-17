/**
 * Electron desktop shell main process: boots the harness host composition
 * (dsh-base bundle + the desktop patch) in-process, serves the built web
 * frontend over the `dsh://` custom protocol (dist, boot manifest, plugin
 * bundles), bridges the web client's API calls over IPC (the shared fetch
 * handler plus pushed event streams), and opens a BrowserWindow.
 * @module @deepseek-ai/dsh-desktop
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, Tray } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-modules'
import { createInternalFallback } from './internal-loader.ts'
import { createDshProtocolHandler, DSH_APP_HOST } from './protocol.ts'
import { installApiHandler, installEventPumps } from './ipc-bridge.ts'
import { buildApplicationMenu, wireTray, type WindowHandle } from './window.ts'

const BIN = 'dsh-desktop'

/** Empty root entry list every desktop composition patches over. */
const ROOT_CONFIG = '# dsh desktop profile root — an empty entry list composed as patches.\n[]\n'

/** Absolute path of this app's package.json (both src/ and lib/ sit one level under it). */
const APP_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The dsh:// scheme this app registers as privileged before app readiness. */
export const DSH_SCHEME = 'dsh'

/**
 * Register the custom-scheme privileges Electron needs before any protocol
 * handler exists: standard (origin-bearing) so relative asset URLs resolve
 * against the page origin, secure so the renderer treats it as trustworthy,
 * and fetch/stream-capable so the module loader's plain <script> tags and the
 * connection carrier can use it.
 */
export function registerDshScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DSH_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ])
}

/** Resolve the built frontend dist root through the frontend package's exports. */
function resolveDistRoot(): string {
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'))
  } catch {
    /* v8 ignore next -- reachable only on a checkout without a built dist; the boot fails loud below anyway */
    throw new Error('dsh-desktop: frontend dist not built; run pnpm run build from the repository root first')
  }
}

/** Resolve the dsh-base bundle patch through its manifest-declared exports. */
function resolveBasePatch(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')
}

/** Absolute path of the desktop patch file shipped beside this app's config. */
function resolveDesktopPatch(): string {
  return join(dirname(APP_ANCHOR), 'config', 'cordis.patch.yml')
}

/**
 * Boot the desktop host composition: dsh-base bundle patch, then the desktop
 * patch (web rows minus the webserver-dependent ones). The profile root lives
 * under the app's user-data directory with the flat module fallback closure
 * linked beside it (the CLI's installed-app contract), so the Loader resolves
 * every bare plugin name from the profile tree. The config file is an empty
 * entry list; the include applies the patches over it. Under Electron the
 * vendored Loader's native internal-loader helper is unreachable, so the
 * prepare step installs the equivalent fallback resolver before any config
 * entry mounts.
 * @returns the settled root context.
 */
export async function bootHost(): Promise<Context> {
  const harnessHome = app.getPath('userData')
  healProfilesModuleFallback(APP_ANCHOR, harnessHome)
  const profileDir = join(harnessHome, 'profiles', 'desktop')
  const fs = await import('node:fs')
  fs.mkdirSync(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  fs.writeFileSync(rootConfig, ROOT_CONFIG)
  return boot(BIN, rootConfig, [
    ...loadOverlayPatches(BIN, resolveBasePatch()),
    ...loadOverlayPatches(BIN, resolveDesktopPatch()),
  ], (ctx) => {
    if (ctx.loader.internal === undefined) {
      ctx.loader.internal = createInternalFallback(rootConfig) as unknown as typeof ctx.loader.internal
    }
  })
}

/** Open the main window at the dsh:// page with the IPC carrier preloaded. */
function openWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      // Sandboxed preloads are CommonJS; the tsdown cjs build emits .cjs.
      preload: join(dirname(APP_ANCHOR), 'lib', 'preload.cjs'),
    },
  })
  // A sandboxed preload that fails to load surfaces silently in the renderer;
  // log the failure and renderer warnings/errors on the main process so a
  // broken bridge is visible without opening DevTools.
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`${BIN}: preload failed to load at ${preloadPath}:`, error)
  })
  win.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.log(`${BIN}: renderer ${details.level}: ${details.message}`)
    }
  })
  void win.loadURL(`${DSH_SCHEME}://${DSH_APP_HOST}/index.html`)
  return win
}

/** Install the application menu and tray over the window (M2 window chrome). */
function installWindowChrome(win: BrowserWindow): { dispose(): void } {
  const handle: WindowHandle = {
    show: () => { win.show() },
    isMinimized: () => win.isMinimized(),
    restore: () => { win.restore() },
    focus: () => { win.focus() },
  }
  buildApplicationMenu({ menu: Menu, app }, handle)
  const trayIcon = join(dirname(APP_ANCHOR), 'resources', 'tray.png')
  const tray = wireTray(new Tray(nativeImage.createFromPath(trayIcon)), { menu: Menu, app }, handle)
  // Closing the window hides it to the tray instead of quitting; Quit comes
  // from the menu, which flips isQuitting so the close actually proceeds.
  let isQuitting = false
  app.on('before-quit', () => { isQuitting = true })
  const onClose = (event: Electron.Event): void => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  }
  win.on('close', onClose)
  return {
    dispose: () => {
      win.removeListener('close', onClose)
      tray?.destroy()
    },
  }
}

/** Install the dsh:// protocol handler over the settled host context. */
function installProtocol(ctx: Context): void {
  protocol.handle(DSH_SCHEME, createDshProtocolHandler({
    distRoot: resolveDistRoot(),
    bootGraph: () => ctx.get('clientModules')?.graph(),
    clientPath: id => ctx.get('clientModules')?.clientPath(id),
  }))
}

/**
 * Verify the settled dispatch face serves the Remote methods the Cordis
 * inventory panel calls (unpackaged diagnostics): the result isolates a
 * broken bridge from a stale build of the host packages.
 * @param ctx - settled host context.
 */
async function selfCheckDispatch(ctx: Context): Promise<void> {
  if (app.isPackaged) return
  const connection = ctx.get('connection') as { fetchHandler?: { fetch(request: Request): Promise<Response> } } | undefined
  if (connection?.fetchHandler === undefined) return
  for (const [method, payload] of [
    ['dynamicCordisRunner/syncInspectManifest', { args: { providers: [] } }],
    ['dynamicCordisRunner/inventory', { args: {} }],
  ] as const) {
    const response = await connection.fetchHandler.fetch(new Request(`http://127.0.0.1/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'boot-self-check', method, payload }),
    }))
    console.log(`${BIN}: self-check ${method} -> ${response.status}`)
  }
}

/** Install the IPC carrier (unary handler + event pumps) for one window. */
function installIpcBridge(ctx: Context, win: BrowserWindow): () => Promise<void> {
  const removeApiHandler = installApiHandler(ctx, ipcMain)
  const pumps = installEventPumps(ctx, win.webContents)
  return async () => {
    removeApiHandler()
    await pumps.dispose()
  }
}

void (async () => {
  registerDshScheme()
  await app.whenReady()
  try {
    const ctx = await bootHost()
    await selfCheckDispatch(ctx)
    installProtocol(ctx)
    const win = openWindow()
    installIpcBridge(ctx, win)
    installWindowChrome(win)
    // With the tray active, closing hides the window and the app keeps
    // running; without it (tests, minimal setups), the last close quits.
    app.on('window-all-closed', () => {
      if (process.platform === 'darwin') return
      void ctx.fiber.dispose().finally(() => { app.quit() })
    })
  } catch (error) {
    console.error(`${BIN}: startup failed:`, inspect(error, { depth: Infinity }))
    app.exit(1)
  }
})()
