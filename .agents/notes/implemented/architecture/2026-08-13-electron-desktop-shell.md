# Agent Note: Electron desktop shell for the dsh web client

Status: implemented

English | [中文](2026-08-13-electron-desktop-shell.zh.md)

## Problem

dsh ships one GUI surface: the browser, reached through `dsh web` (a local HTTP server + WebSocket downlinks, `apps/web` dist served by the host, the `packages/client/*` plugin tree in the renderer). A PC desktop client is a documented intent, not a shipped surface: the [GUI layering note](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) reserves "A future Electron application reuses the same web client packages over an IPC fetch carrier", the [webserver README](../../../../packages/host/webserver/README.md) states "Electron loads dist over `file://` and carries fetch over an IPC bridge", and the [client plugin loading note](../../implemented/architecture/2026-07-23-client-plugin-loading-model.md) lists `dsh-client-connection`'s "transport swap (Electron IPC carrier)" as its standing extension seat.

## Decision

The desktop shell ships as `apps/electron` (`@deepseek-ai/dsh-desktop`): the main process boots the harness host composition in-process (`dsh-base` bundle + a desktop patch that restates the web-only host rows minus the webserver-dependent ones), serves the built web frontend over a privileged `dsh://` custom protocol, bridges the web client's API calls over IPC, and opens a BrowserWindow. The browser surface keeps its exact behavior; the web client packages are reused verbatim, and only the carrier changes.

### Process model

- **Main process = Host.** The main process boots with `@deepseek-ai/dsh-app-boot`'s `boot()` over the `dsh-base` bundle plus the desktop patch (`apps/electron/config/cordis.patch.yml`). The patch restates the web-only host rows (api-gateway, workspace, projection cache, storage, agent presets, the browser roster rows) without the webserver-dependent rows, and pins the connection row to no `webRuntime` inject. The app owns its assembly module; the `apps/cli` profile machinery is not reused.
- **Renderer = the web client.** The renderer loads the built `apps/web` dist with `contextIsolation` and `sandbox` on, mounts it through `new AppWebEntry(el, seams)`, and receives a narrow bridge from the preload script (`lib/preload.cjs`, CommonJS because sandboxed preloads have no ESM context). `window.__DSH_BOOT__` and `/plugins/<id>/client.js` come from the host's `clientModules.graph()` and `clientModules.clientPath(id)` rather than from HTTP.
- **Asset delivery.** The main process registers the privileged `dsh://` protocol (`standard`, `secure`, `supportFetchAPI`, `stream`) serving the dist directory, injecting the boot manifest into `index.html` via the modules node half's `injectBootManifest`, and serving plugin bundles from the registry's resolved paths (`src/protocol.ts`, a pure fetch function).

### The IPC carrier

- **Renderer side.** `ElectronIpcApiClient extends AbstractApiClient` in `dsh-client-connection` implements `doFetch` as `bridge.invoke('dsh:api', { url, init })` returning a serialized `{ status, headers, body }` rebuilt into a `Response`, and overrides `openMux`/`openHost` to read frames pushed by the main process over a `bridge.on('dsh:event', …)` channel, honoring the passed `AbortSignal` (`src/client/electron-ipc-api-client.ts`). The class depends only on the narrow `DshIpcBridge` interface — never on the `electron` module — so the browser package stays clean and the existing `InProcessApiClient`/`WebApiClient`/`FixtureApiClient` family is untouched.
- **Main side.** The connection node half's `webServer` inject is optional (`ctx.get('webServer')`; routes register only when the server exists), and `HostConnectionService` exposes `HostConnectionDispatch.fetchHandler` — the shared `/api` dispatch face with the privileged-method fence, built once in the service constructor. The desktop assembly serves it over `ipcMain.handle('dsh:api', …)` and pumps both event streams (`apiProxy.events.mux/host`) to the renderer (`src/ipc-bridge.ts`, injected electron surfaces for testability).
- **Trust model.** The IPC channel is reachable only from the app's own renderer (preload bridge, no remote content), so loopback-equivalence holds by construction. The privileged-method check stays in the shared handler so the same dispatch path cannot widen authority if a remote renderer ever appears.
- **Carrier selection.** The connection client half picks the carrier by page mode: `?fixture` first, then `window.__dshBridge` presence → `ElectronIpcApiClient`, else `WebApiClient`.

### Native capabilities

- **Directory picker.** `packages/host/directory-picker-electron` registers the `native` capability kind on the [directory-picker seam](../../../../packages/host/directory-picker/README.md) using Electron's `dialog.showOpenDialog` (injectable dialog surface for tests). Its browser half is the shared `dsh-client-ui-directory-picker-native` package (drives `host.pickDirectory` over the IPC carrier); the desktop composition mounts both rows. The auto chooser is not used — it samples the webserver bind, which the desktop omits.
- **Host desktop actions.** `host.openPath` and `settings.openDocument` run through the Host's existing platform openers, which work unchanged in the main process; the desktop composition gets them via platform detection (no `nativeOpen` pin). Swapping to Electron's `shell.openPath` is deferred until a consumer needs it.
- **Window chrome** lives in `src/window.ts`: application menu (appMenu on macOS, File/Edit, Window with Show Main Window, Quit), tray with close-to-tray (close hides; `before-quit` bypasses), injected electron surfaces for testability.

### Packaging and development workflow

- Distribution uses electron-builder (`electron-builder.yml`): NSIS (win x64), DMG (mac arm64 + x64), AppImage + deb (linux x64). `executableName: dsh-desktop` pins the binary name. `electronDist` points at the locally installed dist so no release-CDN download is needed. Native modules (`node-addon-require-builtin`, `node-addon-landlock-run`, `node-pty`, `koffi`) are unpacked from asar. Icon assets (`resources/icon.png`, `tray.png`) are generated by `scripts/generate-icons.mjs` (placeholder artwork). Auto-update is not v1.
- The `@electron/get` version mismatch (electron-builder 26 reads `ElectronDownloadCacheMode`, which only @electron/get 5.x exports) is fixed by a pnpm override to 5.1.0.
- Development: `pnpm run build` then `pnpm --filter @deepseek-ai/dsh-desktop dev`; the renderer reuses `?fixture` for keyless UI work. `client-hmr` is disabled in the desktop composition; bundle rebuilds reach the app through a full renderer reload.

## Alternatives considered

**Tauri or a bare WebView2 shell.** The Host is Node/Cordis; Electron's main process runs the harness composition in-process through `boot()` with zero transport change. Tauri or a sidecar WebView would force a sidecar Node process or fall back to the HTTP carrier, giving up the in-process assembly the layering note reserves.

**A minimal shell that points a WebView at `http://127.0.0.1:3080`.** Zero client changes and the fastest demo, but it keeps the HTTP service, loses native integration, and is exactly the "browser in a frame" the reserved design avoids.

**A custom-protocol fetch carrier instead of IPC** (`dsh://` forwarding `/api` to `toFetchHandler`, SSE for both streams, `WebApiClient`-like subclass). All changes concentrate in the main process and the renderer stays closer to browser semantics, but it departs from the recorded IPC-bridge direction and would re-derive reconnect and cancellation semantics at the protocol layer.

**A native client over the SDK or ACP.** The SDK is a turn-based automation protocol with no GUI plane (no projections, commands, settings); ACP is automation-only by contract. Reproducing the `dsh web` experience that way means rebuilding the entire UI.

**`file://` delivery with `BootSeams.loadBundle` and preload-injected manifest.** Workable, but `file://` blocks cross-directory scripts and fetch; `dsh://` reuses `injectBootManifest`, `defaultLoadBundle`, and the modules registry's resolved paths with no client-kernel changes.

## Consequences

- **Node-version risk cleared.** Electron 43.4.0 bundles Node 24.18.1, satisfying the repository engines (`^22.19.0 || >=24.0.0`).
- **Browser behavior unchanged.** The connection node half's `webServer` optionality and the shared fetch handler are backward-compatible; `test:gui` (3767 tests, including the new IPC-carrier and window-chrome suites) and the full coverage gate pass with 100% per-file coverage on the new files.
- **Known environment limits.** The `DSH_SNAPSHOT=replay test:web` browser lane needs chromium system libraries (libnspr4) unavailable in this container; the Electron binary and Playwright cannot run locally, so installer smoke and browser replay are CI's job. `rescope-vendor` reports 26 pre-existing residue tokens unrelated to this work.
- **IPC unary has no mid-flight abort** — `ipcRenderer.invoke` cannot cancel the main-process dispatch; caller-side timeouts still reject the renderer promise, and the host handler's result is discarded. A streaming/cancelable IPC path is deferred until a consumer needs it.
- **The desktop patch restates web rows** — it derives from the web-app bundle patch minus the webserver rows; a change to the web roster must be mirrored there (or the derivation automated).
- **Platform installer verification is pending** — Linux `--dir` packaging and the asar layout are verified; AppImage/deb tooling and NSIS/DMG need platform runners (CI).
