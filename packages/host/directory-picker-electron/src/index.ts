/**
 * Electron dialog backend of the directory-picker seam: registers
 * `ctx.directoryPicker` with the `native` capability, opening one
 * `dialog.showOpenDialog` directory chooser on the host display per pick.
 * This backend is composed only by the desktop shell, whose host context runs
 * in the Electron main process — the only place Electron's dialog API is
 * available. Other deployments compose the `-native` (OS tooling) or
 * `-browse` (in-app) backend instead.
 *
 * The dialog surface is injected so the driver is testable without an
 * Electron runtime; the app passes the real `dialog`.
 * @module @deepseek-ai/dsh-host-directory-picker-electron
 */

import { createRequire } from 'node:module'
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'

/** The slice of electron's dialog this backend uses. */
export interface ElectronDialogSurface {
  showOpenDialog(
    options: {
      title: string
      properties: ['openDirectory', 'createDirectory']
    },
  ): Promise<{ canceled: boolean; filePaths: string[] }>
}

/** Injectable dialog surface for deterministic tests (defaults to the real electron dialog). */
export interface ElectronDirectoryPickerInternals {
  dialog?: ElectronDialogSurface
}

/** Resolve the dialog surface: the injected one, or electron's real dialog when absent. */
function dialogSurface(internals: ElectronDirectoryPickerInternals): ElectronDialogSurface {
  if (internals.dialog !== undefined) return internals.dialog
  return electronDialogSurface()
}

/**
 * The electron module is a peerDependency loaded by the app's main process;
 * importing here keeps the module importable in tests that inject the
 * surface without an Electron runtime.
 */
/* v8 ignore next 4 -- requires the electron module; tests always inject the surface, so this arm cannot run in a test environment */
function electronDialogSurface(): ElectronDialogSurface {
  const { dialog } = requireElectron()
  return dialog
}

/**
 * Open the Electron directory chooser.
 * @param _signal - seam-required caller lifetime; not wired to close the open
 * dialog (the dialog stays until the operator answers; a gone caller's result
 * is discarded).
 * @param internals - dialog surface hook for deterministic tests.
 * @returns the selected absolute path, or null when the operator cancels.
 */
export async function pickElectronDirectory(
  _signal: AbortSignal,
  internals: ElectronDirectoryPickerInternals = {},
): Promise<string | null> {
  const dialog = dialogSurface(internals)
  const result = await dialog.showOpenDialog({
    title: 'Select Workspace Directory',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/** The `ctx.directoryPicker` Electron implementation (stable capability object per service life). */
export default class ElectronDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    /* v8 ignore next -- pure forward to pickElectronDirectory (its spec owns behavior); invoking here opens a real chooser. */
    pick: signal => pickElectronDirectory(signal),
  }

  /**
   * The native interaction capability.
   * @returns the stable `native` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}

// Electron's dialog is a singleton import; loading it lazily keeps this
// module importable in tests that inject the surface (a vitest node
// environment has no Electron runtime). The module is CJS, so the require
// goes through createRequire.
const electronRequire = createRequire(import.meta.url)
let electronDialog: ElectronDialogSurface | undefined
function requireElectron(): { dialog: ElectronDialogSurface } {
  if (electronDialog === undefined) {
    electronDialog = (electronRequire('electron') as { dialog: ElectronDialogSurface }).dialog
  }
  return { dialog: electronDialog }
}
