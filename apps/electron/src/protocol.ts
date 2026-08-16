/**
 * The `dsh://` protocol handler: serves the built web frontend dist, injects
 * the boot manifest into index.html, and serves plugin bundles — the Electron
 * analogue of the browser carrier's webserver + frontend-static + modules
 * routes, as a pure fetch function so it is testable without Electron.
 *
 * URL layout (same-origin with the page, host `app`):
 * - `/index.html` or `/` — the dist index with `window.__DSH_BOOT__` injected
 * - `/assets/...` and any other dist file — served verbatim from the dist root
 * - `/plugins/<id>/client.js[.map]` — the composed client bundle for that graph id
 * - anything else — 404
 * @module @deepseek-ai/dsh-desktop/protocol
 */

import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { injectBootManifest, resolvePluginBundlePath, type WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** The dsh:// page origin host this app serves. */
export const DSH_APP_HOST = 'app'

/** Extension → content-type map for the dist's asset classes (frontend-static's minimal table). */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
}

/** Dependencies the handler resolves from the live host context. */
export interface DshProtocolDeps {
  /** Absolute path of the built frontend dist directory. */
  distRoot: string
  /** The current composed boot graph (absent until the modules node half provides it). */
  bootGraph: () => WebBootGraph | undefined
  /** Resolve a graph id to its built client bundle path. */
  clientPath: (id: string) => string | undefined
}

/** Content type for a dist file path (octet-stream fallback, mirroring frontend-static). */
function contentTypeOf(path: string): string {
  return MIME[extname(path)] ?? 'application/octet-stream'
}

/** Content type for the SPA index (closed over the fixed key). */
const INDEX_CONTENT_TYPE = 'text/html; charset=utf-8'

/** Content type for plugin source maps (closed over the fixed key). */
const SOURCE_MAP_CONTENT_TYPE = 'application/json; charset=utf-8'

/** Whether a dist-relative path escapes the dist root. */
function escapesDistRoot(distRoot: string, rel: string): boolean {
  const target = resolve(distRoot, rel)
  const base = resolve(distRoot)
  return target !== base && !target.startsWith(`${base}${sep}`)
}

/**
 * Create the dsh:// fetch handler.
 * @param deps - dist root, boot-graph provider, and bundle-path resolver.
 * @returns a WHATWG fetch function serving the dsh:// URL space.
 */
export function createDshProtocolHandler(deps: DshProtocolDeps): (request: Request) => Promise<Response> {
  const root = resolve(deps.distRoot)
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.hostname !== DSH_APP_HOST) {
      return new Response('not found', { status: 404 })
    }
    const pathname = decodeURIComponent(url.pathname)

    // Boot manifest injection on the SPA index.
    if (pathname === '/' || pathname === '/index.html') {
      let html: string
      try {
        html = await readFile(resolve(root, 'index.html'), 'utf8')
      } catch {
        return new Response('not found', { status: 404 })
      }
      const graph = deps.bootGraph()
      return new Response(graph === undefined ? html : injectBootManifest(html, graph), {
        headers: { 'content-type': INDEX_CONTENT_TYPE },
      })
    }

    // Plugin bundles from the composed graph (the modules node half's URL
    // space, served here instead of through its webserver route). An
    // unresolvable /plugins path is a 404, never a dist fallback.
    if (pathname.startsWith('/plugins/')) {
      const pluginPath = resolvePluginBundlePath(pathname, id => deps.clientPath(id))
      if (pluginPath === undefined) {
        return new Response('not found', { status: 404 })
      }
      try {
        const body = await readFile(pluginPath)
        return new Response(body, {
          headers: {
            'content-type': pluginPath.endsWith('.map') ? SOURCE_MAP_CONTENT_TYPE : 'text/javascript; charset=utf-8',
            'cache-control': 'no-cache',
          },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    }

    // Static dist assets, traversal-contained.
    const rel = pathname.startsWith('/') ? pathname.slice(1) : pathname
    if (rel === '' || escapesDistRoot(root, rel)) {
      return new Response('not found', { status: 404 })
    }
    try {
      const body = await readFile(resolve(root, rel))
      return new Response(body, { headers: { 'content-type': contentTypeOf(rel) } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  }
}
