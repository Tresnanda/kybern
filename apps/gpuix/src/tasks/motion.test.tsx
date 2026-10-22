import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'

let visible = true
mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => visible, onWindowVisibility: () => () => {} }))

const { CountPop } = await import('./CountPop.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

const native = PATCHED_NATIVE ? test : test.skip

function harness() {
  const children = new Map<number, number[]>(), custom = new Map<number, Record<string, any>>()
  let rootId = 0
  const detach = (id: number) => { for (const list of children.values()) { const at = list.indexOf(id); if (at >= 0) list.splice(at, 1) } }
  const renderer = {
    applyBatch(json: string) {
      const gone: number[] = []
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') { children.set(id, []); custom.set(id, {}) }
        else if (op === 'setCustomProp') custom.get(id)![a] = b
        else if (op === 'appendChild') { detach(a); children.get(id)!.push(a) }
        else if (op === 'insertBefore') { detach(a); const list = children.get(id)!; const at = list.indexOf(b); list.splice(at < 0 ? list.length : at, 0, a) }
        else if (op === 'removeChild') detach(a)
        else if (op === 'destroyElement') { detach(id); gone.push(id) }
        else if (op === 'setRoot') rootId = id
      }
      return gone
    },
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
  }
  const root = createRoot(renderer)
  const walk = (id: number, out: number[] = []) => { out.push(id); for (const child of children.get(id) ?? []) walk(child, out); return out }
  return {
    render: (node: ReactNode) => { flushSync(() => root.render(node)) },
    ids: () => walk(rootId).map(id => custom.get(id)?.testId as string | undefined).filter(Boolean) as string[],
    pops: () => walk(rootId).filter(id => custom.get(id)?.paintAnimation?.kind === 'pop').length,
  }
}

native('a count pops when it changes, not on its first render or when it stays the same', () => {
  const h = harness()
  h.render(<CountPop value={3} color="#fff" />)
  expect(h.pops()).toBe(0)
  h.render(<CountPop value={3} color="#fff" />)
  expect(h.pops()).toBe(0)
  h.render(<CountPop value={4} color="#fff" />)
  expect(h.pops()).toBe(1)
})

native('a count that changes with its context (a filter, a search) shows at once; a later change in that context pops', () => {
  const h = harness()
  h.render(<CountPop value={3} context="todo" color="#fff" />)
  h.render(<CountPop value={5} context="project:a" color="#fff" />)
  expect(h.pops()).toBe(0)
  h.render(<CountPop value={6} context="project:a" color="#fff" />)
  expect(h.pops()).toBe(1)
})
