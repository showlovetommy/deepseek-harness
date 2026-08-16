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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, Tray } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-modules'
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
 * patch (web rows minus the webserver-dependent ones). The config file is an
 * empty entry list written to the app's user-data directory so Loader has a
 * real include root to anchor `baseUrl`; bare plugin names resolve from the
 * app's own installation (this package's node_modules), not the user-data
 * directory.
 * @returns the settled root context.
 */
export async function bootHost(): Promise<Context> {
  const rootConfig = join(app.getPath('userData'), 'cordis.yml')
  const fs = await import('node:fs')
  fs.writeFileSync(rootConfig, ROOT_CONFIG)
  const appRoot = pathToFileURL(dirname(APP_ANCHOR)).href + '/'
  return boot(BIN, rootConfig, [
    ...loadOverlayPatches(BIN, resolveBasePatch()),
    ...loadOverlayPatches(BIN, resolveDesktopPatch()),
  ], undefined, appRoot)
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
