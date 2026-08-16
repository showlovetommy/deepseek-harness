# Agent Note: dsh web 客户端的 Electron 桌面壳

Status: implemented

[English](2026-08-13-electron-desktop-shell.md) | 中文

## 问题

dsh 目前只提供一个 GUI 形态：浏览器，经 `dsh web` 访问（本地 HTTP 服务器 + WebSocket 下行链路，宿主提供 `apps/web` dist，renderer 运行 `packages/client/*` 插件树）。PC 桌面客户端是有记录的设计意图，但还不是已交付的表层：[GUI 分层笔记](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)预留了 "A future Electron application reuses the same web client packages over an IPC fetch carrier"；[webserver README](../../../../packages/host/webserver/README.md)写明 "Electron loads dist over `file://` and carries fetch over an IPC bridge"；[客户端插件加载笔记](../../implemented/architecture/2026-07-23-client-plugin-loading-model.md)把 `dsh-client-connection` 的 "transport swap (Electron IPC carrier)" 列为它的常设扩展位。

## 决策

桌面壳作为 `apps/electron`（`@deepseek-ai/dsh-desktop`）交付：主进程在进程内组合 harness 宿主（`dsh-base` bundle + 桌面 patch——重述仅限 web 的宿主行、去掉依赖 webserver 的行），经特权 `dsh://` 自定义协议服务构建好的 web 前端，经 IPC 桥接 web 客户端的 API 调用，并打开 BrowserWindow。浏览器表层保持现有行为不变；web 客户端包原样复用，只更换载体。

### 进程模型

- **主进程 = Host。**主进程用 `@deepseek-ai/dsh-app-boot` 的 `boot()` 在 `dsh-base` bundle 之上组合，外加桌面 patch（`apps/electron/config/cordis.patch.yml`）。patch 重述仅限 web 的宿主行（api-gateway、workspace、projection cache、storage、agent presets、浏览器名册行），去掉依赖 webserver 的行，并把 connection 行钉为不注入 `webRuntime`。应用自持组装模块；不复用 `apps/cli` 的 profile 机制。
- **renderer = web 客户端。**renderer 以 `contextIsolation` 与 `sandbox` 开启加载构建好的 `apps/web` dist，经 `new AppWebEntry(el, seams)` 挂载，由 preload 脚本（`lib/preload.cjs`，CommonJS——沙箱 preload 无 ESM 上下文）注入窄桥。`window.__DSH_BOOT__` 与 `/plugins/<id>/client.js` 来自宿主的 `clientModules.graph()` 与 `clientModules.clientPath(id)`，而非 HTTP。
- **资源交付。**主进程注册特权 `dsh://` 协议（`standard`、`secure`、`supportFetchAPI`、`stream`）：服务 dist 目录、经 modules node half 的 `injectBootManifest` 向 `index.html` 注入引导清单、从注册表解析出的路径服务插件 bundle（`src/protocol.ts`，纯 fetch 函数）。

### IPC 载体

- **renderer 侧。**`dsh-client-connection` 的 `ElectronIpcApiClient extends AbstractApiClient` 把 `doFetch` 实现为 `bridge.invoke('dsh:api', { url, init })`，返回序列化 `{ status, headers, body }` 重建为 `Response`；`openMux`/`openHost` 改为读取主进程经 `bridge.on('dsh:event', …)` 通道推送的帧，并遵守传入的 `AbortSignal`（`src/client/electron-ipc-api-client.ts`）。该类只依赖窄桥接口 `DshIpcBridge`——绝不依赖 `electron` 模块——因此浏览器包保持干净，现有 `InProcessApiClient`/`WebApiClient`/`FixtureApiClient` 家族不受影响。
- **主进程侧。**connection node half 的 `webServer` 注入变为可选（`ctx.get('webServer')`；仅当服务器存在时注册 route），`HostConnectionService` 暴露 `HostConnectionDispatch.fetchHandler`——含特权方法栅栏的共享 `/api` 分发面，在服务构造函数中构建一次。桌面组装经 `ipcMain.handle('dsh:api', …)` 服务它，并把两条事件流（`apiProxy.events.mux/host`）泵送到 renderer（`src/ipc-bridge.ts`，注入 electron 表面以便测试）。
- **信任模型。**IPC 通道只有应用自己的 renderer（preload 桥、无远程内容）可达，因此 loopback 等价性由构造保证。特权方法检查保留在共享 handler 里，即使未来出现远程 renderer，同一分发路径也不会扩大授权。
- **载体选择。**connection 客户端半侧按页面模式选择载体：`?fixture` 优先，其次 `window.__dshBridge` 存在 → `ElectronIpcApiClient`，否则 `WebApiClient`。

### 原生能力

- **目录选择。**`packages/host/directory-picker-electron` 在[目录选择 seam](../../../../packages/host/directory-picker/README.md)上注册 `native` 能力 kind（用 Electron 的 `dialog.showOpenDialog`，对话框表面可注入以便测试）。其浏览器半侧是共享的 `dsh-client-ui-directory-picker-native` 包（经 IPC 载体驱动 `host.pickDirectory`）；桌面组合挂载这两行。不使用 auto chooser——它会采样 webserver bind，而桌面省略了它。
- **宿主桌面动作。**`host.openPath` 与 `settings.openDocument` 走 Host 既有的平台打开器，在主进程无需改动即可工作；桌面组合经平台探测获得它们（无需 `nativeOpen` 钉死）。换用 Electron 的 `shell.openPath` 延后到有消费方需要时。
- **窗口 chrome** 位于 `src/window.ts`：应用菜单（macOS 的 appMenu、File/Edit、Window 含 Show Main Window、Quit）、托盘与关窗入托（关闭即隐藏；`before-quit` 绕过），注入 electron 表面以便测试。

### 打包与开发工作流

- 分发用 electron-builder（`electron-builder.yml`）：NSIS（win x64）、DMG（mac arm64 + x64）、AppImage + deb（linux x64）。`executableName: dsh-desktop` 钉死二进制名。`electronDist` 指向本地已安装的 dist，无需 release-CDN 下载。原生模块（`node-addon-require-builtin`、`node-addon-landlock-run`、`node-pty`、`koffi`）从 asar 解包。图标资源（`resources/icon.png`、`tray.png`）由 `scripts/generate-icons.mjs` 生成（占位图稿）。v1 不做自动更新。
- `@electron/get` 版本不匹配（electron-builder 26 读取 `ElectronDownloadCacheMode`，只有 @electron/get 5.x 导出它）由 pnpm override 到 5.1.0 修复。
- 开发：`pnpm run build` 后 `pnpm --filter @deepseek-ai/dsh-desktop dev`；renderer 复用 `?fixture` 做无 key UI 开发。桌面组合禁用 `client-hmr`；bundle 重建通过 renderer 整体 reload 进入应用。

## 备选方案

**Tauri 或裸 WebView2 shell。**Host 是 Node/Cordis；Electron 主进程可经 `boot()` 在进程内运行 harness 组合，零传输改动。Tauri 或 sidecar WebView 会迫使引入 sidecar Node 进程或退回 HTTP 载体，放弃分层笔记预留的进程内组装。

**指向 `http://127.0.0.1:3080` 的最小 shell。**客户端零改动、最快出 demo，但它保留 HTTP 服务、失去原生集成，正是预留设计要避免的「框架里的浏览器」。

**用自定义协议 fetch 载体代替 IPC**（`dsh://` 把 `/api` 转发给 `toFetchHandler`，两条流走 SSE，近似 `WebApiClient` 的子类）。所有改动集中在主进程、renderer 更贴近浏览器语义，但它偏离已记录的 IPC 桥方向，且要在协议层重推重连与取消语义。

**基于 SDK 或 ACP 的原生客户端。**SDK 是轮次式自动化协议，没有 GUI 面（无投影、命令、设置）；ACP 按契约只服务自动化。用那条路复刻 `dsh web` 体验等于重建整个 UI。

**`file://` 交付 + `BootSeams.loadBundle` + preload 注入清单。**可行，但 `file://` 阻止跨目录脚本与 fetch；`dsh://` 复用 `injectBootManifest`、`defaultLoadBundle` 与 modules 注册表解析出的路径，客户端内核零改动。

## 结果

- **Node 版本风险已解除。**Electron 43.4.0 内置 Node 24.18.1，满足仓库 engines（`^22.19.0 || >=24.0.0`）。
- **浏览器行为不变。**connection node half 的 `webServer` 可选化与共享 fetch handler 向后兼容；`test:gui`（3767 个测试，含新增 IPC 载体与窗口 chrome 套件）与全量覆盖率 gate 通过，新文件逐文件 100% 覆盖。
- **已知环境限制。**`DSH_SNAPSHOT=replay test:web` 浏览器通道需要本容器缺失的 chromium 系统库（libnspr4）；Electron 二进制与 Playwright 无法本地运行，因此安装器冒烟与浏览器重放属于 CI。`rescope-vendor` 报告 26 个与本工作无关的既有残留 token。
- **IPC unary 无中途中止**——`ipcRenderer.invoke` 无法取消主进程分发；调用方侧超时仍会拒绝 renderer promise，宿主 handler 的结果被丢弃。可流式／可取消的 IPC 路径延后到有消费方需要时。
- **桌面 patch 重述 web 行**——它派生自 web-app bundle patch 去掉 webserver 行；web 名册变更必须在此镜像（或自动化派生）。
- **平台安装包验证待 CI**——Linux `--dir` 打包与 asar 布局已验证；AppImage/deb 工具链与 NSIS/DMG 需要平台 runner（CI）。
