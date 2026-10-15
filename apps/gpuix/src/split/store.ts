import { useSyncExternalStore } from 'react'
import { canSplitPane, collectThreadPanes, findParentSplit, findThreadPane, removeThreadPane, replacePaneThread, setSplitNodeRatio, splitThreadPane, type Pane, type SplitDirection, type SplitSide } from '../../../desktop/src/state/splitView.ts'
import { createPane, closePaneState, DEFAULT_PANE, focusPane, getFocusedPaneId, getState, getPane, selectPaneThread, setPane, subscribe } from '../state.ts'
import { load, save } from '../shell/persist.ts'
import { onEnvironmentChange, onEnvironmentLeaving } from '../shell/environment.ts'
export { canSplitPane, collectThreadPanes }
export type { Pane, SplitDirection, SplitSide }
let restoring = false
let started = false
const KEY = 'kybern.split-view.v1'
let root: Pane = { kind: 'leaf', id: DEFAULT_PANE, threadId: null }
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
const listen = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const getSplitRoot = () => root
export const useSplitRoot = () => useSyncExternalStore(listen, getSplitRoot)
export function useFocusedPane() { return useSyncExternalStore(subscribe, getFocusedPaneId) }
function persist() { if (!started || restoring) return; save(KEY, { version: 1, root, focusedPaneId: getFocusedPaneId() }) }
export function splitPane(target: string, direction: SplitDirection, threadId: string | null = null, side: SplitSide = 'second') {
  const result = splitThreadPane({ root, targetPaneId: target, direction, threadId, side })
  if (!result) return false
  root = result.root
  createPane(result.addedPaneId)
  focusPane(result.addedPaneId)
  void selectPaneThread(result.addedPaneId, threadId).catch(console.error)
  persist(); notify()
  return true
}
export const splitFocusedPane = (direction: SplitDirection, threadId?: string | null) => splitPane(getFocusedPaneId(), direction, threadId)
export function closePane(id: string) {
  if (root.kind === 'leaf') return
  const next = removeThreadPane(root, id)
  if (!next) return
  const parent = findParentSplit(root, id)
  const sibling = parent && (parent.first.id === id ? parent.second : parent.first)
  if (getFocusedPaneId() === id && sibling) focusPane(collectThreadPanes(sibling)[0]!.id)
  root = next
  closePaneState(id)
  persist(); notify()
}
export function maximizePane(id: string) {
  const target = findThreadPane(root, id)
  if (!target) return
  const others = collectThreadPanes(root).filter(pane => pane.id !== id)
  root = target
  for (const pane of others) closePaneState(pane.id)
  focusPane(id); persist(); notify()
}
export function resizePane(id: string, ratio: number) {
  const next = setSplitNodeRatio(root, id, ratio)
  if (next === root) return
  root = next; persist(); notify()
}
let persistedFocus = getFocusedPaneId()
subscribe(() => {
  if (!started || restoring) return
  let next = root
  for (const pane of collectThreadPanes(root)) next = replacePaneThread(next, pane.id, getPane(pane.id)?.selectedId ?? null)
  const changed = next !== root || persistedFocus !== getFocusedPaneId()
  persistedFocus = getFocusedPaneId()
  if (next !== root) { root = next; notify() }
  if (changed) persist()
})
function valid(value: unknown, depth = 0, ids = new Set<string>()): value is Pane {
  if (!value || typeof value !== 'object' || depth > 2) return false
  const p = value as Pane
  if (typeof p.id !== 'string' || ids.has(p.id)) return false
  ids.add(p.id)
  if (p.kind === 'leaf') return p.threadId === null || typeof p.threadId === 'string'
  return p.kind === 'split' && (p.direction === 'horizontal' || p.direction === 'vertical') && Number.isFinite(p.ratio) && p.ratio >= .25 && p.ratio <= .75 && valid(p.first, depth + 1, ids) && valid(p.second, depth + 1, ids)
}
function restore() {
  const stored = load<{ version: number; root: Pane; focusedPaneId: string } | null>(KEY, null)
  root = { kind: 'leaf', id: DEFAULT_PANE, threadId: null }
  if (stored?.version !== 1 || !valid(stored.root)) { restoring = false; notify(); return }
  restoring = true
  // Do not persist the intermediate empty panes while restoring selection.
  const saved = stored.root
  for (const leaf of collectThreadPanes(saved)) createPane(leaf.id)
  for (const leaf of collectThreadPanes(saved)) setPane(leaf.id, { selectedId: leaf.threadId })
  root = saved
  if (!findThreadPane(root, DEFAULT_PANE)) closePaneState(DEFAULT_PANE)
  focusPane(findThreadPane(root, stored.focusedPaneId)?.id ?? collectThreadPanes(root)[0]!.id)
  restoring = false
  if (getState().status === 'open') for (const leaf of collectThreadPanes(root)) if (leaf.threadId) void selectPaneThread(leaf.id, leaf.threadId).catch(console.error)
  persist(); notify()
}
export function startSplitView() { if (!started) { started = true; restore() } }
onEnvironmentLeaving(() => { restoring = true })
onEnvironmentChange(() => { if (started) restore() }, -40)
