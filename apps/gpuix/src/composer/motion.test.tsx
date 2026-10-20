import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'

let visible = true
mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => visible, onWindowVisibility: () => () => {} }))

const { useLeavingList } = await import('./motion.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

const native = PATCHED_NATIVE ? test : test.skip

/** Records the rendered `testId`s (a leaving entry renders as `<id>*`) in tree order. */
function harness() {
  const children = new Map<number, number[]>(), custom = new Map<number, Record<string, unknown>>()
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
  }
}

type Item = { id: string }
let release: (id?: string) => void = () => {}
function List({ items, leaves }: { items: readonly Item[]; leaves?: (id: string) => boolean }) {
  const [entries, gone] = useLeavingList(items, leaves)
  release = gone
  return <div>{entries.map(e => <div key={e.item.id} testId={`${e.item.id}${e.leaving ? '*' : ''}${e.fresh ? '+' : ''}`} />)}</div>
}
const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }

native('a removed item stays as a leaving entry until released; the others keep their place', () => {
  const h = harness(), initial = [a, b, c]
  h.render(<List items={initial} />)
  expect(h.ids()).toEqual(['a', 'b', 'c'])
  h.render(<List items={[a, c]} />)
  expect(h.ids()).toEqual(['a', 'b*', 'c'])
  release('b')
  h.render(<List items={[a, c]} />)
  expect(h.ids()).toEqual(['a', 'c'])
})

native('items present at the first render are not fresh; items added later are, and release() clears every leaving entry', () => {
  const h = harness()
  h.render(<List items={[a]} />)
  h.render(<List items={[a, b]} />)
  expect(h.ids()).toEqual(['a', 'b+'])
  h.render(<List items={[]} />)
  expect(h.ids()).toEqual(['a*', 'b*+'])
  release()
  h.render(<List items={[]} />)
  expect(h.ids()).toEqual([])
})

native('an item the owner does not want an exit for disappears at once', () => {
  const h = harness()
  h.render(<List items={[a, b]} leaves={id => id !== 'a'} />)
  h.render(<List items={[b]} leaves={id => id !== 'a'} />)
  expect(h.ids()).toEqual(['b'])
})

native('putting a leaving item back revives it without a new entrance', () => {
  const h = harness()
  h.render(<List items={[a, b]} />)
  h.render(<List items={[a]} />)
  expect(h.ids()).toEqual(['a', 'b*'])
  h.render(<List items={[a, b]} />)
  expect(h.ids()).toEqual(['a', 'b'])
})

native('a hidden window cannot complete an exit, so nothing is kept', () => {
  visible = false
  const h = harness()
  h.render(<List items={[a, b]} />)
  h.render(<List items={[a]} />)
  expect(h.ids()).toEqual(['a'])
  visible = true
})
