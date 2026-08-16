import { defineConfig } from 'tsdown'

/**
 * Node-only backend: the main-process dialog surface. electron stays an
 * external runtime require (its package owns the binary), like every host
 * consumer of the desktop shell.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['electron'],
  },
})
