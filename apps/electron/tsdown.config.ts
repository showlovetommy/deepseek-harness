import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships the main-process entry (with its protocol and IPC
 * modules) and the preload script. The root tsdown builds only
 * `lib/types/index.js`, so this override points at the tsc-emitted entries;
 * their reachable modules bundle with them. Declarations come from `tsc -b`
 * (dts: false), matching every package.
 *
 * `deps.onlyBundle: []` keeps every dependency external — the electron module
 * must stay a runtime require (its package owns the binary download), and the
 * workspace packages resolve through the installed tree like apps/cli's.
 *
 * The preload is emitted as CommonJS: sandboxed preload scripts run as plain
 * JavaScript without an ESM context (the sandboxed preload can only
 * `require('electron')`), so `format: 'cjs'` is not a choice but a
 * requirement. The `.js` extension resolves as CJS in that context; the
 * package's `"type": "module"` does not apply to sandboxed preloads.
 */
export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      // electron stays a runtime require: the module's package owns the binary
      // download, and bundling it would inline the installer stub.
      neverBundle: ['electron'],
    },
  },
  {
    entry: ['lib/types/preload.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: ['electron'],
    },
  },
])
