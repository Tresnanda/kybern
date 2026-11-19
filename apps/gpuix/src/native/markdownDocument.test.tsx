import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { Component, type ReactNode } from 'react'
import { DocumentMarkdown } from './markdownDocument.tsx'

const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

class Boundary extends Component<{ children: ReactNode; caught: unknown[] }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { this.props.caught.push(error) }
  render() { return this.state.failed ? null : this.props.children }
}

/** The native worker as documented: eight pending jobs, the ninth is refused with "Markdown queue is full (8 jobs)". */
function fakeNative(options: { fail?: string } = {}) {
  const batches: string[] = []
  const stats = { pending: 0, peak: 0, refused: 0, created: 0, released: [] as string[], ids: 0 }
  const renderer = {
    applyBatch(ops: unknown) { batches.push(typeof ops === 'string' ? ops : JSON.stringify(ops)); return [] },
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
    async createMarkdownDocument(_source: { text: string }) {
      if (options.fail) throw Error(options.fail)
      if (stats.pending >= 8) { stats.refused++; throw Error('Markdown queue is full (8 jobs)') }
      stats.pending++; stats.peak = Math.max(stats.peak, stats.pending)
      await Bun.sleep(2)
      stats.pending--; stats.created++
      return { id: `doc-${++stats.ids}`, revision: 1, blocks: [], stablePrefixBlocks: 0, parsedBytes: 1 }
    },
    updateMarkdownDocument() { throw Error('unexpected') },
    releaseMarkdownDocument(id: string) { stats.released.push(id) },
  }
  return { renderer, batches, stats }
}

const settle = async (ms = 1) => { await Bun.sleep(ms); flushSync(() => {}); await Bun.sleep(ms) }
const bodies = (count: number) => Array.from({ length: count }, (_, i) => <DocumentMarkdown key={i} source={`Paragraph ${i}`} />)
const logged: unknown[][] = []
const original = console.error
beforeEach(() => { logged.length = 0; console.error = (...args: unknown[]) => { logged.push(args) } })
afterEach(() => { console.error = original })

test('thirty bodies mounted at once all become documents without a queue-full failure', async () => {
  const native = fakeNative(), caught: unknown[] = []
  const root = createRoot(native.renderer)
  try {
    flushSync(() => root.render(<Boundary caught={caught}>{bodies(30)}</Boundary>))
    for (let i = 0; i < 200 && native.stats.created < 30; i++) await settle(2)
    await settle(5)
    expect(native.stats.created).toBe(30)
    expect(native.stats.refused).toBe(0)
    expect(native.stats.peak).toBeLessThanOrEqual(6)
    expect(caught).toEqual([])
    expect(logged).toEqual([])
    const all = native.batches.join('')
    for (let id = 1; id <= 30; id++) expect(all).toContain(`"doc-${id}"`)
  } finally { root.unmount(); await settle() }
})

test('a worker that is already busy with other callers makes bodies wait, not fail', async () => {
  const native = fakeNative(), caught: unknown[] = []
  native.stats.pending = 8 // someone else holds every worker slot
  setTimeout(() => { native.stats.pending = 0 }, 30)
  const root = createRoot(native.renderer)
  try {
    flushSync(() => root.render(<Boundary caught={caught}>{bodies(4)}</Boundary>))
    for (let i = 0; i < 200 && native.stats.created < 4; i++) await settle(5)
    expect(native.stats.created).toBe(4)
    expect(native.stats.refused).toBeGreaterThan(0)
    expect(caught).toEqual([])
  } finally { root.unmount(); await settle() }
})

test('unmounting drops queued bodies and releases the ones already created', async () => {
  const native = fakeNative(), caught: unknown[] = []
  const root = createRoot(native.renderer)
  flushSync(() => root.render(<Boundary caught={caught}>{bodies(30)}</Boundary>))
  await settle(1)
  root.unmount()
  await settle(20)
  expect(native.stats.created).toBeLessThan(30)
  expect(native.stats.released.length).toBe(native.stats.created)
  expect(native.stats.pending).toBe(0)
  expect(caught).toEqual([])
})

test('a real worker failure draws that body as plain Markdown and never reaches the page', async () => {
  const native = fakeNative({ fail: 'span limit exceeded' }), caught: unknown[] = []
  const root = createRoot(native.renderer)
  try {
    flushSync(() => root.render(<Boundary caught={caught}><DocumentMarkdown source="Plain **fallback** text" /></Boundary>))
    await settle(5)
    expect(caught).toEqual([])
    expect(native.batches.join('')).toContain('Plain **fallback** text')
    expect(logged.length).toBe(1)
  } finally { root.unmount(); await settle() }
})
