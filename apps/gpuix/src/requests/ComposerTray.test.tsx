import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { PATCHED_NATIVE } from '../native/local-build.ts'

mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => true, onWindowVisibility: () => () => {} }))
const { ComposerTray, peekHeight } = await import('./ComposerTray.tsx')
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
    /** Every test id in tree (paint) order. */
    testIds: () => walk(rootId).map(id => custom.get(id)?.testId).filter((id): id is string => typeof id === 'string'),
    /** The nearest ancestor of `id` (itself included) with a paint transform. */
    /** The nearest ancestor of `id` (itself included) whose paint transform animates opacity: a reveal, not a control's own press scale. */
    transformAbove: (id: number) => { for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) { const transform = custom.get(at)?.paintTransform; if (transform?.animate?.opacity !== undefined) return transform } return undefined },
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

test('each kind of row gets its own section, labelled only when it has rows, in a fixed order', () => {
  const h = harness()
  const task = { id: 't1', thread_id: 'parent', origin_turn_id: 'turn', started_seq: 1, updated_seq: 1, kind: 'process', status: 'running', title: 'bun test', backgrounded: true, stats: {}, capabilities: { stop: true }, started_at: at, updated_at: at } as never
  const queued = { id: 'q1', thread_id: 'parent', message: { parts: [{ type: 'text', text: 'Also check light mode' }] } } as never
  h.render(<ThemeProvider><ComposerTray data={{ threadId: 'parent', subagents: [working], tasks: [task], helpers: [], queued: [queued] }} /></ThemeProvider>)
  const labels = h.testIds().filter(id => id.startsWith('composer-tray-label-'))
  expect(labels).toEqual(['composer-tray-label-subagents', 'composer-tray-label-tasks', 'composer-tray-label-queued'])
  // Subagent rows come right after their label, tasks and queued rows after theirs.
  const ids = h.testIds()
  expect(ids.indexOf('subagent-open-w1')).toBeGreaterThan(ids.indexOf('composer-tray-label-subagents'))
  expect(ids.indexOf('subagent-open-w1')).toBeLessThan(ids.indexOf('composer-tray-label-tasks'))
  expect(ids.indexOf('queued-q1')).toBeGreaterThan(ids.indexOf('composer-tray-label-queued'))
})

test('a scrolling tray ends halfway down the row nearest seven and a half rows', () => {
  const label = (key: string, height: number) => ({ key: `label-${key}`, height })
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ key: `r${from + i}`, height: 28 }))
  // One section: a label, then rows; the edge cuts the row whose middle is nearest the target.
  expect(peekHeight([label('a', 29), ...rows(10)], 7 * 28 + 29 + 14)).toBe(29 + 7 * 28 + 14)
  // A later label never takes the cut: the half row after it does.
  expect(peekHeight([label('a', 29), ...rows(6), label('b', 35), ...rows(3, 6)], 7 * 28 + 29 + 14)).toBe(29 + 6 * 28 + 35 + 14)
})
