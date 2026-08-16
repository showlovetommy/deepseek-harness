# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

Electron 桌面壳：主进程在进程内组合 harness 宿主（`dsh-base` bundle + 桌面 patch——web 行去掉依赖 webserver 的行），经 `dsh://` 自定义协议（dist、引导清单、插件 bundle）服务构建好的 web 前端，经 IPC 桥接 web 客户端的 API 调用，并打开 BrowserWindow。renderer 就是来自 [`apps/web`](../web/README.md) 的未修改 web 客户端，经 `AppWebEntry` 挂载，开启 `contextIsolation` 与 `sandbox`。

桌面应用遵循 [GUI 分层笔记](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) 的设计：web 客户端包原样复用，只更换载体。IPC 载体（M1）已就位：preload 暴露窄桥 `window.__dshBridge`；unary/respond 调用经 `ipcRenderer.invoke` 到达主进程，由浏览器载体桥接到 HTTP route 的同一个共享 fetch handler 分发（含特权方法栅栏）；mux 与 host 事件流由主进程推送到 renderer。原生桌面能力（M2）已就位：目录选择是 Electron 对话框后端（[`dsh-host-directory-picker-electron`](../../packages/host/directory-picker-electron/README.md)）配共享原生交互客户端面，窗口 chrome（应用菜单、托盘与关窗入托）位于 [`src/window.ts`](src/window.ts)。`host.openPath` 与 `settings.openDocument` 走 Host 既有的平台打开器，在主进程中无需改动即可工作。桌面组合刻意不包含 `webServer` 服务；[`dsh-client-connection`](../../packages/client/connection/README.md) 与 [`dsh-client-modules`](../../packages/client/modules/README.md) 在无它的情况下挂载，并暴露 graph／dispatch 面供 shell 自行服务。

## 开发

```sh
pnpm run build              # build lib + web dist (required once)
pnpm --filter @deepseek-ai/dsh-desktop dev
```

## 打包（M3）

```sh
pnpm run dist                # electron-builder: NSIS (win) / DMG (mac) / AppImage+deb (linux)
pnpm run dist:dir            # unpacked app directory (fast packaging check)
```

`electron-builder.yml` 持有目标：Windows 用 NSIS，macOS 用 DMG（arm64 + x64），Linux 用 AppImage + deb。构建好的 web 前端经 `@deepseek-ai/dsh-web-frontend` 依赖随包；原生模块（Loader 的 bare-specifier 助手、landlock-run、node-pty）从 asar 解包。图标资源（`resources/icon.png`、`tray.png`）由 `scripts/generate-icons.mjs` 生成（占位图，待设计师提供真实品牌资源）。

窗口打开 `dsh://app/index.html`。配置了 `DEEPSEEK_API_KEY` 时真实宿主 API 经 IPC 流动；追加 `?fixture` 仍可通过 fixture 载体无 key 渲染完整 UI。`dsh://` handler 位于 [`src/protocol.ts`](src/protocol.ts)，是纯 fetch 函数；IPC 桥位于 [`src/ipc-bridge.ts`](src/ipc-bridge.ts)，注入 electron 表面以便单测。宿主启动冒烟测试（[`tests/boot.host.spec.ts`](tests/boot.host.spec.ts)）boot 真实的 base + 桌面组合，断言 `clientModules` 存在、`webServer` 不存在，且真实 `session.list` envelope 经 IPC handler 分发成功。

## 模型体验

无，因为 shell 原样复用 web 客户端；模型可见的表层上下文由被组合的 web 行（本桌面 patch 重述了它们）持有。

#### KV Cache 影响

无；本包不组装也不发送任何提供方请求。

## 已知限制与暂缓事项

- **图标资源是生成的占位**——`resources/icon.png`／`tray.png` 来自 `scripts/generate-icons.mjs`（深色圆角方块加 V 形）；真实品牌图稿会替换它们。
- **桌面 patch 重述 web 行**——它派生自 web-app bundle patch 去掉 webserver 行；web 名册变更必须在此镜像（或自动化派生）。
- **IPC unary 无中途中止**——`ipcRenderer.invoke` 无法取消主进程分发；调用方侧超时仍会拒绝 renderer promise，宿主 handler 的结果被丢弃。可流式／可取消的 IPC 路径延后到有消费方需要时。
- **Electron 内置 Node 版本必须满足仓库 engines**（`^22.19.0 || >=24.0.0`）；在依赖仅 Node 的 API 前先验证所选 Electron 线。
