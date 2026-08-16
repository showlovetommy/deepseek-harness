/** dsh:// protocol handler: dist serving, manifest injection, plugin bundles, containment. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { createDshProtocolHandler, DSH_APP_HOST } from '../src/protocol.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Build a fake dist tree and a handler over it. */
function makeHandler(overrides?: {
  graph?: WebBootGraph
  clientPath?: (id: string) => string | undefined
}): { handler: (request: Request) => Promise<Response>; distRoot: string } {
  root = mkdtempSync(join(tmpdir(), 'dsh-desktop-protocol-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("dist")\n')
  const handler = createDshProtocolHandler({
    distRoot: root,
    bootGraph: () => overrides?.graph,
    clientPath: overrides?.clientPath ?? (() => undefined),
  })
  return { handler, distRoot: root }
}

const GRAPH: WebBootGraph = {
  rev: 'abc123',
  entries: [
    { id: '@deepseek-ai/dsh-client-ui-layout', url: '/plugins/@deepseek-ai/dsh-client-ui-layout/client.js?rev=abc123', rev: 'abc123' },
  ],
}

describe('dsh:// protocol handler', () => {
  it('serves the SPA index with the boot manifest injected', async () => {
    const { handler } = makeHandler({ graph: GRAPH })
    const response = await handler(new Request(`dsh://${DSH_APP_HOST}/index.html`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await response.text()
    expect(html).toContain('window.__DSH_BOOT__')
    expect(html).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(html.indexOf('__DSH_BOOT__')).toBeLessThan(html.indexOf('<div id="root">'))
  })

  it('serves the root path as the index and omits the manifest without a graph', async () => {
    const { handler } = makeHandler()
    const response = await handler(new Request(`dsh://${DSH_APP_HOST}/`))
    const html = await response.text()
    expect(html).not.toContain('__DSH_BOOT__')
  })

  it('serves dist assets with their content type', async () => {
    const { handler } = makeHandler()
    const response = await handler(new Request(`dsh://${DSH_APP_HOST}/assets/app.js`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await response.text()).toBe('console.log("dist")\n')
  })

  it('serves plugin bundles and source maps from the composed graph', async () => {
    makeHandler()
    const clientPath = (id: string): string | undefined =>
      id === '@deepseek-ai/dsh-client-ui-layout' ? join(root!, 'bundle', 'client.js') : undefined
    mkdirSync(join(root!, 'bundle'), { recursive: true })
    writeFileSync(join(root!, 'bundle', 'client.js'), 'module.exports = {}\n')
    writeFileSync(join(root!, 'bundle', 'client.js.map'), '{"version":3}\n')
    // Rebuild the handler with the bundle resolver now that the bundle exists.
    const handlerWithBundles = createDshProtocolHandler({
      distRoot: root!,
      bootGraph: () => GRAPH,
      clientPath,
    })
    const bundle = await handlerWithBundles(new Request(`dsh://${DSH_APP_HOST}/plugins/@deepseek-ai/dsh-client-ui-layout/client.js`))
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await bundle.text()).toBe('module.exports = {}\n')
    const map = await handlerWithBundles(new Request(`dsh://${DSH_APP_HOST}/plugins/@deepseek-ai/dsh-client-ui-layout/client.js.map`))
    expect(map.status).toBe(200)
    expect(map.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })

  it('404s unknown plugins, unknown dist files, traversal, and foreign hosts', async () => {
    const { handler } = makeHandler({ graph: GRAPH })
    for (const url of [
      `dsh://${DSH_APP_HOST}/plugins/unknown/client.js`,
      `dsh://${DSH_APP_HOST}/nope.js`,
      `dsh://${DSH_APP_HOST}/../etc/passwd`,
      `dsh://${DSH_APP_HOST}/assets/..%2f..%2fsecret`,
      'dsh://other/index.html',
    ]) {
      const response = await handler(new Request(url))
      expect(response.status).toBe(404)
    }
  })
})
