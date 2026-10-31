import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

// Review 2026-10-21: a missing image made three requests (the load, its one automatic retry, then one more).
let requests = 0
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('missing', { status: 404 }) } })
const real = await import('../state.ts')
const { KybernClient } = await import('../../../../packages/kybern-client/src/client.ts')
const fake = new KybernClient({ url: `ws://127.0.0.1:${server.port}/ws`, token: 'test' })
mock.module('../state.ts', () => ({ ...real, getClient: () => fake, threadClient: () => fake }))
mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => true, onWindowVisibility: () => () => {} }))
const { ThreadImage } = await import('./ThreadImage.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

test('a missing image is asked for twice: once, then one automatic retry', async () => {
  const texts: string[] = []
  const renderer = {
    applyBatch(json: string) { for (const [op, , a] of JSON.parse(json) as [string, number, any][]) if (op === 'setText') texts.push(a); return [] },
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
    addLayoutObserver: () => 1, removeLayoutObserver() {}, isLayoutObserverActive: () => true,
  }
  const root = createRoot(renderer)
  flushSync(() => root.render(<ThemeProvider><ThreadImage threadId="thread" source="shots/missing.png" alt="Missing" /></ThemeProvider>))
  await Bun.sleep(2600)
  expect(requests).toBe(2)
  expect(texts.some(t => t.includes('Image not found'))).toBe(true)
  root.unmount()
  server.stop(true)
})
