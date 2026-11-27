// A GPUIX renderer that only records the tree, so sheet tests can find elements, read their text and fire events.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'

const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

export { flushSync }

export function harness() {
  const children = new Map<number, number[]>()
  const custom = new Map<number, Record<string, any>>()
  const styles = new Map<number, Record<string, any>>()
  const listeners = new Map<number, Set<string>>()
  const text = new Map<number, string>()
  let rootId = 0
  const detach = (id: number) => {
    for (const list of children.values()) {
      const at = list.indexOf(id)
      if (at >= 0) list.splice(at, 1)
    }
  }
  const renderer = {
    applyBatch(json: string) {
      const gone: number[] = []
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') { children.set(id, []); custom.set(id, {}); styles.set(id, {}); listeners.set(id, new Set()) }
        else if (op === 'setCustomProp') custom.get(id)![a] = b
        else if (op === 'setStyle') styles.set(id, (a ?? {}) as Record<string, any>)
        else if (op === 'setEventListener') {
          if (b) listeners.get(id)!.add(a)
          else listeners.get(id)!.delete(a)
        }
        else if (op === 'setText') text.set(id, String(a ?? ''))
        else if (op === 'appendChild') { detach(a); children.get(id)!.push(a) }
        else if (op === 'insertBefore') {
          detach(a)
          const list = children.get(id)!
          const at = list.indexOf(b)
          list.splice(at < 0 ? list.length : at, 0, a)
        }
        else if (op === 'removeChild') detach(a)
        else if (op === 'destroyElement') { detach(id); gone.push(id) }
        else if (op === 'setRoot') rootId = id
      }
      return gone
    },
    setWindowKeyEvents() {},
    setWindowSelectionChange() {},
    addLayoutObserver: () => 1,
    removeLayoutObserver() {},
    isLayoutObserverActive: () => true,
    focusElement() {},
  }
  const root = createRoot(renderer)
  const walk = (id: number, out: number[] = []) => {
    out.push(id)
    for (const child of children.get(id) ?? []) walk(child, out)
    return out
  }
  const textOf = (id: number): string => {
    const parts: string[] = []
    for (const node of walk(id)) {
      const own = text.get(node)
      if (own) parts.push(own)
      const propText = custom.get(node)?.text
      if (typeof propText === 'string') parts.push(propText)
    }
    return parts.join(' ')
  }
  return {
    close: () => { flushSync(() => root.render(null)) },
    /** Everything on screen, as one string. */
    text: () => textOf(rootId),
    render: (node: ReactNode) => { flushSync(() => root.render(node)) },
    find: (testId: string) => walk(rootId).find((id) => custom.get(id)?.testId === testId),
    props: (id: number) => custom.get(id) ?? {},
    style: (id: number) => styles.get(id) ?? {},
    listeners: (id: number) => listeners.get(id) ?? new Set<string>(),
    textOf,
    fire: (id: number, payload: Record<string, unknown>) => flushSync(() => handleGpuixEvent({ elementId: id, ...payload }, renderer)),
  }
}
