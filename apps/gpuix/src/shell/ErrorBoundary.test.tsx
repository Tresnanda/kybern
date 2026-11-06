import { expect, spyOn, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
import { useEffect, useRef } from 'react'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { ThemeProvider } from '../ui.tsx'
import { observeElementBounds } from '../native/layout.ts'

function harness() {
  const custom = new Map<number, Record<string, unknown>>()
  const renderer = {
    applyBatch(json: string) {
      for (const [op, id, key, value] of JSON.parse(json)) {
        if (op === 'createElement') custom.set(id, {})
        if (op === 'setCustomProp') custom.get(id)![key] = value
        if (op === 'removeElement') custom.delete(id)
      }
      return []
    },
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
    addLayoutObserver() { throw Error('Element is not mounted') }, removeLayoutObserver() {},
  }
  return { renderer, root: createRoot(renderer), custom }
}
const until = async (ready: () => boolean) => {
  const end = Date.now() + 2000
  while (!ready()) { if (Date.now() > end) throw Error('boundary did not settle'); await new Promise(resolve => setTimeout(resolve, 1)) }
}

test('a transient failure remounts the surface automatically', async () => {
  const h = harness()
  let failed = false
  function Child() { useEffect(() => { if (!failed) { failed = true; throw Error('transient') } }, []); return <div testId="recovered" /> }
  flushSync(() => h.root.render(<ThemeProvider><ErrorBoundary><Child /></ErrorBoundary></ThemeProvider>))
  await until(() => [...h.custom.values()].some(p => p.testId === 'recovered'))
  expect(failed).toBe(true)
  h.root.unmount()
})

test('a persistent effect failure retries twice and then stops rendering', async () => {
  const h = harness()
  let mounts = 0
  function Broken() { useEffect(() => { mounts++; throw Error('persistent') }, []); return <div /> }
  flushSync(() => h.root.render(<ThemeProvider><ErrorBoundary><Broken /></ErrorBoundary></ThemeProvider>))
  await until(() => [...h.custom.values()].some(p => p.testId === 'error-fallback'))
  expect(mounts).toBe(3)
  await new Promise(resolve => setImmediate(resolve))
  expect(mounts).toBe(3)
  expect([...h.custom.values()].some(p => p.testId === 'error-fallback')).toBe(true)
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000)
  try {
    flushSync(() => h.root.render(<ThemeProvider><ErrorBoundary><Broken /></ErrorBoundary></ThemeProvider>))
    expect([...h.custom.values()].some(p => p.testId === 'error-fallback')).toBe(true)
  } finally { clock.mockRestore() }
  h.root.unmount()
})

test('a transcript host lost between render and effect stays unpainted without a boundary failure', async () => {
  const h = harness()
  let observations = 0
  function Row() {
    const host = useRef<{ id: number } | null>(null)
    useEffect(() => observeElementBounds(h.renderer, host.current!, e => { expect(e.rect).toBeNull(); observations++ }), [])
    return <div ref={node => { host.current = node }} testId="transcript-row" />
  }
  flushSync(() => h.root.render(<ThemeProvider><ErrorBoundary label="transcript"><Row /></ErrorBoundary></ThemeProvider>))
  await until(() => observations > 0)
  expect(observations).toBe(1)
  expect([...h.custom.values()].some(p => p.testId === 'error-fallback')).toBe(false)
  h.root.unmount()
})
