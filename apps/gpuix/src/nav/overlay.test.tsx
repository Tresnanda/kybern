import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'

const { Menu, MenuItem, MenuSub } = await import('./overlay.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

/** Records the element tree and test ids, and delivers events to one element. */
function harness() {
  const bounds: Record<string, {x: number; y: number; width: number; height: number}> = {
    "root-menu": { x: 100, y: 50, width: 220, height: 300 },
    "remote-menu": { x: 320, y: 75, width: 216, height: 80 },
  }
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
    getElementBounds: (id: number) => bounds[custom.get(id)?.testId] ?? null,
    focusElement() {},
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
    addLayoutObserver: () => 1, removeLayoutObserver() {}, isLayoutObserverActive: () => true,
  }
  const root = createRoot(renderer)
  const walk = (id: number, out: number[] = []) => { out.push(id); for (const child of children.get(id) ?? []) walk(child, out); return out }
  return {
    close: () => { flushSync(() => root.render(null)) },
    render: (node: ReactNode) => { flushSync(() => root.render(node)) },
    find: (testId: string) => walk(rootId).find(id => custom.get(id)?.testId === testId)!,
    fire: (id: number, payload: Record<string, unknown>) => flushSync(() => handleGpuixEvent({ elementId: id, ...payload }, renderer)),
  }
}


const pause = () => Bun.sleep(75)
const point = { x: 200, y: 90 }
function menuHarness() {
  const h = harness()
  const picked: string[] = []
  h.render(<ThemeProvider><Menu testId="root" open trigger={() => <div />}>
    <MenuItem id="terminal" label="New terminal" onSelect={() => {}} />
    <MenuSub id="remote" testId="remote" label="New terminal on…">
      <MenuItem id="satya" testId="satya" label="SatyaMas" onSelect={() => picked.push('SatyaMas')} />
    </MenuSub>
    <MenuItem id="preview" label="Browser" onSelect={() => {}} />
  </Menu></ThemeProvider>)
  return { ...h, picked }
}

test('a layout hover-leave inside the parent does not close the clicked machine submenu', async () => {
  const h = menuHarness()
  try {
    h.fire(h.find('remote'), { eventType: 'mouseMove', ...point })
    // Real native hover reconciliation reports a leave without pointer movement,
    // after the original move. The old 50ms heuristic treats this as an exit.
    await Bun.sleep(20)
    h.fire(h.find('root-menu'), { eventType: 'mouseLeave', ...point })
    h.fire(h.find('remote'), { eventType: 'click', ...point })
    await pause()
    expect(h.find('remote-menu')).toBeDefined()
    h.fire(h.find('satya'), { eventType: 'click', x: 400, y: 100 })
    expect(h.picked).toEqual(['SatyaMas'])
  } finally { h.close() }
})

test('entering the submenu keeps it open; leaving the whole tree closes it', async () => {
  const h = menuHarness()
  try {
    h.fire(h.find('remote'), { eventType: 'click', ...point })
    h.fire(h.find('root-menu'), { eventType: 'mouseLeave', x: 400, y: 100 })
    await pause()
    expect(h.find('remote-menu')).toBeDefined()
    h.fire(h.find('remote-menu'), { eventType: 'mouseLeave', x: 600, y: 400 })
    await pause()
    expect(h.find('remote-menu')).toBeUndefined()
  } finally { h.close() }
})
