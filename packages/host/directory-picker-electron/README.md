# @deepseek-ai/dsh-host-directory-picker-electron

English | [中文](README.zh.md)

The **Electron dialog backend** of the [directory-picker seam](../directory-picker/README.md): `ElectronDirectoryPicker` registers `ctx.directoryPicker` with the `native` capability, whose `pick(signal)` opens one `dialog.showOpenDialog` directory chooser per call and resolves the chosen absolute path (`null` on cancel). This backend is composed only by the [desktop shell](../../../apps/electron/README.md), whose host context runs in the Electron main process — the only place Electron's dialog API is available. Other deployments compose the [`-native`](../directory-picker-native/README.md) (OS tooling) or [`-browse`](../directory-picker-browse/README.md) (in-app) backend instead. The dialog surface is injectable so the driver is testable without an Electron runtime; the app passes the real `dialog`.

The browser half of the native interaction is the shared [`dsh-client-ui-directory-picker-native`](../../client/ui-directory-picker-native/README.md) package: it drives the `host.pickDirectory` RPC and does not branch on which backend registered the capability, so the desktop composition pairs this host row with that client row.

## Model Experience

None, as the backend serves the GUI host's directory selection; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Main-process only** — Electron's dialog API is available only in the main process; composing this backend anywhere else fails at the first pick.
- **No abort propagation to a visible dialog** — the caller's `AbortSignal` is not wired to close an open dialog; the result is discarded when the caller went away (the dialog itself stays until the operator answers).
