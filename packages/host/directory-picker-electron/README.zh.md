# @deepseek-ai/dsh-host-directory-picker-electron

[English](README.md) | 中文

[目录选择 seam](../directory-picker/README.md) 的 **Electron 对话框后端**：`ElectronDirectoryPicker` 以 `native` 能力注册 `ctx.directoryPicker`，其 `pick(signal)` 每次调用打开一个 `dialog.showOpenDialog` 目录选择器，并解析所选绝对路径（取消时返回 `null`）。本后端只由[桌面壳](../../../apps/electron/README.md)组合——其宿主上下文运行在 Electron 主进程，这是 Electron dialog API 唯一可用的位置。其他部署改用 [`-native`](../directory-picker-native/README.md)（OS 工具）或 [`-browse`](../directory-picker-browse/README.md)（应用内）后端。对话框表面可注入，因此驱动逻辑无需 Electron 运行时即可测试；应用传入真实 `dialog`。

原生交互的浏览器半侧复用共享的 [`dsh-client-ui-directory-picker-native`](../../client/ui-directory-picker-native/README.md) 包：它驱动 `host.pickDirectory` RPC，不按注册能力的后端分支，因此桌面组合把本宿主行与该客户端行配对。

## Model Experience

无，因为后端服务 GUI 宿主的目录选择；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包不组装也不发送任何提供方请求。

## Known Limitations and Deferred Work

- **仅主进程可用**——Electron 的 dialog API 只在主进程可用；在其他位置组合本后端会在首次 pick 时失败。
- **中止不传播到可见对话框**——调用方的 `AbortSignal` 没有接到关闭已打开对话框的通道；调用方离开后结果被丢弃（对话框本身会停留到操作者应答）。
