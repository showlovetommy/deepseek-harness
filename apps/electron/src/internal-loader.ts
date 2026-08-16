/**
 * Internal-loader substitute for the vendored Loader's Include import path
 * under Electron: bare package names resolve from the profile tree (the
 * `profiles/node_modules` closure links) through a CommonJS resolver, which
 * matches the ESM `default` export condition every dsh package declares.
 * @module @deepseek-ai/dsh-desktop
 */

import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Minimal import surface the Loader's Include path requires from the Node
 * internal module loader. The real loader (see the vendored ModuleLoader
 * helper) is unreachable under Electron's patched Node, so the shell supplies
 * this equivalent.
 */
export interface InternalLoaderFallback {
  import(specifier: string, baseUrl: string, attributes?: Record<string, unknown>): Promise<unknown>
}

/**
 * Build the fallback internal loader for the Loader's Include import path.
 * The real Node internal loader is only reachable through a native helper
 * (`node-addon-require-builtin`) that the isolated pnpm layout does not place
 * on the vendored Loader's resolution chain, so under Electron the Loader's
 * bare-name import would otherwise fall back to a plain `import()` from the
 * Loader's own directory, which cannot see the app's package tree. Relative,
 * absolute, and file: specifiers resolve against `baseUrl` (the profile
 * directory); bare package names resolve from the profile's `node_modules`
 * closure links created by the app-boot `healProfilesModuleFallback` helper.
 * @param anchor - an absolute path inside the profile directory; the resolver
 * anchors its node_modules walk there.
 * @returns the import surface the Loader calls with `(specifier, baseUrl)`.
 */
export function createInternalFallback(anchor: string): InternalLoaderFallback {
  const require = createRequire(join(dirname(anchor), 'noop.cjs'))
  return {
    import(specifier: string, baseUrl: string): Promise<unknown> {
      const url = specifier.startsWith('file:')
        ? new URL(specifier)
        : specifier.startsWith('.') || isAbsolute(specifier)
          ? new URL(specifier, baseUrl)
          : pathToFileURL(require.resolve(specifier))
      return import(url.href)
    },
  }
}
