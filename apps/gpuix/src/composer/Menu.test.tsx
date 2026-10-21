import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'

mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => true, onWindowVisibility: () => () => {} }))
const { PopupLayer } = await import('./Menu.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

/** Records the element tree and test ids, and delivers events to one element. */
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
    addLayoutObserver: () => 1, removeLayoutObserver() {}, isLayoutObserverActive: () => true,
  }
  const root = createRoot(renderer)
  const walk = (id: number, out: number[] = []) => { out.push(id); for (const child of children.get(id) ?? []) walk(child, out); return out }
  return {
    render: (node: ReactNode) => { flushSync(() => root.render(node)) },
    find: (testId: string) => walk(rootId).find(id => custom.get(id)?.testId === testId)!,
    fire: (id: number, payload: Record<string, unknown>) => flushSync(() => handleGpuixEvent({ elementId: id, ...payload }, renderer)),
  }
}

test('a leaving popup answers no keys or outside presses', () => {
  const h = harness(), keys: string[] = [], outside: number[] = []
  const popup = (leaving: boolean) => <ThemeProvider><PopupLayer testId="popup" leaving={leaving} onLeft={() => {}} onKeyDown={(e: { key?: string }) => keys.push(e.key ?? '')} onMouseDownOutside={() => outside.push(1)}><div /></PopupLayer></ThemeProvider>
  h.render(popup(false))
  h.fire(h.find('popup'), { eventType: 'keyDown', key: 'enter' })
  h.fire(h.find('popup'), { eventType: 'mouseDownOutside' })
  expect(keys).toEqual(['enter'])
  expect(outside).toEqual([1])
  // A pointer pick closes it: during its exit an Enter must not run the item again.
  h.render(popup(true))
  h.fire(h.find('popup'), { eventType: 'keyDown', key: 'enter' })
  h.fire(h.find('popup'), { eventType: 'mouseDownOutside' })
  expect(keys).toEqual(['enter'])
  expect(outside).toEqual([1])
})
