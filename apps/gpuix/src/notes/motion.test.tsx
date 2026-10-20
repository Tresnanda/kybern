import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import type { NoteSummary } from '../../../../packages/kybern-client/src/types.ts'

let visible = true
mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => visible, onWindowVisibility: () => () => {} }))

const { useFreshNotes, useLeavingNotes, markNoteLeaving, thumbLift, cardIn } = await import('./motion.ts')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)

const native = PATCHED_NATIVE ? test : test.skip

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

const note = (id: string): NoteSummary => ({ id, title: id } as NoteSummary)
const a = note('a'), b = note('b'), c = note('c')
let release: (id: string) => void = () => {}
function Gallery({ visible: list, context = 'x' }: { visible: NoteSummary[]; all?: NoteSummary[]; context?: string }) {
  const leaving = useLeavingNotes(list)
  const fresh = useFreshNotes(list, context)
  release = leaving.gone
  return <div>{leaving.list.map(n => <div key={n.id} testId={`${n.id}${leaving.leaving.has(n.id) ? '*' : ''}${fresh.has(n.id) ? '+' : ''}`} />)}</div>
}

native('a pointer-deleted note keeps its card until released; a keyboard delete removes it at once', () => {
  const h = harness(), full = [a, b, c]
  h.render(<Gallery visible={full} all={full} />)
  markNoteLeaving(b)
  h.render(<Gallery visible={[a, c]} all={full} />)
  expect(h.ids()).toEqual(['a', 'c', 'b*'])
  release('b')
  h.render(<Gallery visible={[a, c]} all={full} />)
  expect(h.ids()).toEqual(['a', 'c'])
  h.render(<Gallery visible={[a]} all={full} />)
  expect(h.ids()).toEqual(['a'])
})

native('a mark made before the gallery mounted keeps the deleted card from the full list', () => {
  const h = harness()
  markNoteLeaving(c)
  h.render(<Gallery visible={[a, b]} all={[a, b, c]} />)
  expect(h.ids()).toEqual(['a', 'b', 'c*'])
})

native('notes that appear under an unchanged filter are fresh; a filter or search change is not', () => {
  const h = harness()
  h.render(<Gallery visible={[a]} all={[a, b]} />)
  h.render(<Gallery visible={[a, b]} all={[a, b]} />)
  expect(h.ids()).toEqual(['a', 'b+'])
  h.render(<Gallery visible={[a, b, c]} all={[a, b, c]} context="other" />)
  expect(h.ids()).toEqual(['a', 'b', 'c'])
})

native('a bulk arrival of more than twelve notes enters plainly', () => {
  const h = harness(), many = Array.from({ length: 14 }, (_, i) => note(`n${i}`))
  h.render(<Gallery visible={[a]} all={[a]} />)
  h.render(<Gallery visible={[a, ...many]} all={[a, ...many]} />)
  expect(h.ids().some(id => id.endsWith('+'))).toBe(false)
})

native('the card entrance staggers the first four and lifts translate paint-only', () => {
  expect(cardIn(0)!.transition!.delay).toBe(0)
  expect(cardIn(9)!.transition!.delay).toBeCloseTo(0.075)
  expect(thumbLift(true)!.animate).toEqual({ translateY: -2 })
  expect(thumbLift(false)!.animate).toEqual({ translateY: 0 })
})
