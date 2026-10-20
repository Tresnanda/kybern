import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { PATCHED_NATIVE } from '../native/local-build.ts'

mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => true, onWindowVisibility: () => () => {} }))
const { ComposerTray } = await import('./ComposerTray.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

/** Records the element tree and props, and delivers events to one element (no bubbling, as GPUIX focus events). */
function harness() {
  const children = new Map<number, number[]>(), custom = new Map<number, Record<string, any>>(), parent = new Map<number, number>()
  let rootId = 0
  const detach = (id: number) => { for (const list of children.values()) { const at = list.indexOf(id); if (at >= 0) list.splice(at, 1) } }
  const renderer = {
    applyBatch(json: string) {
      const gone: number[] = []
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') { children.set(id, []); custom.set(id, {}) }
        else if (op === 'setCustomProp') custom.get(id)![a] = b
        else if (op === 'appendChild') { detach(a); children.get(id)!.push(a); parent.set(a, id) }
        else if (op === 'insertBefore') { detach(a); const list = children.get(id)!; const at = list.indexOf(b); list.splice(at < 0 ? list.length : at, 0, a); parent.set(a, id) }
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
  const find = (testId: string) => walk(rootId).find(id => custom.get(id)?.testId === testId)!
  return {
    render: (node: React.ReactNode) => { flushSync(() => root.render(node)) },
    find,
    /** The nearest ancestor of `id` (itself included) with a paint transform. */
    transformAbove: (id: number) => { for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) if (custom.get(at)?.paintTransform) return custom.get(at)!.paintTransform; return undefined },
    fire: (id: number, eventType: string) => flushSync(() => handleGpuixEvent({ eventType, elementId: id }, renderer)),
  }
}

const at = new Date().toISOString()
const working = { id: 'w1', title: 'Measure the tray', project_id: 'p', provider: { kind: 'claude-code', instance: 'default' }, status: 'running', permission_mode: 'supervised', created_at: at, updated_at: at, parent_thread_id: 'parent',
  subagent: { task_id: 'w1', root_thread_id: 'parent', parent_turn_id: 'turn', agent_type: 'Explore', status: 'running', started_at: at, completed_at: null, capabilities: { stop: true, background: true } } } as never

;(PATCHED_NATIVE ? test : test.skip)('Tab onto a row action reveals the actions; leaving the row hides them', () => {
  const h = harness()
  h.render(<ThemeProvider><ComposerTray data={{ threadId: 'parent', subagents: [working], tasks: [], helpers: [], queued: [] }} /></ThemeProvider>)
  const stop = h.find('subagent-stop-w1'), background = h.find('subagent-background-w1')
  expect(h.transformAbove(stop).animate.opacity).toBe(0)
  h.fire(stop, 'focus')
  expect(h.transformAbove(stop).animate.opacity).toBe(1)
  // Tab to the next action: its focus may arrive before the old one's blur.
  h.fire(background, 'focus'); h.fire(stop, 'blur')
  expect(h.transformAbove(stop).animate.opacity).toBe(1)
  h.fire(background, 'blur')
  expect(h.transformAbove(stop).animate.opacity).toBe(0)
})
