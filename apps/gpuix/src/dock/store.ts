// Dock choices belong to the selected thread; closing a tab discards its content.
// Bounded session storage keeps revisiting threads cheap without persisting user data.
import { useSyncExternalStore } from 'react'
import { getState } from '../state.ts'

export type DockTab = 'agents' | 'activity' | 'changes' | 'explorer' | 'project' | 'notes' | 'tasks' | 'review' | 'artifacts' | 'terminal' | 'preview'
export interface DockState {
  open: boolean
  tabs: DockTab[]
  tab: DockTab | null
  width: number
  instant: boolean
}
const DEFAULT: DockState = { open: false, tabs: ['agents'], tab: 'agents', width: 538, instant: false }
const choices = new Map<string, DockState>()
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const getDock = (id: string | null) => choices.get(id ?? 'home') ?? DEFAULT
export function useDock(id: string | null) { return useSyncExternalStore(subscribe, () => getDock(id)) }
export function setDock(id: string | null, patch: Partial<DockState>) {
  const key = id ?? 'home'
  if (!choices.has(key) && choices.size >= 80) choices.delete(choices.keys().next().value!)
  choices.set(key, { ...getDock(id), ...patch })
  emit()
}
export function toggleDock(instant = false) {
  const id = getState().selectedId
  setDock(id, { open: !getDock(id).open, instant })
}
export function chooseTab(id: string | null, tab: DockTab) {
  const current = getDock(id)
  setDock(id, { tab, tabs: current.tabs.includes(tab) ? current.tabs : [...current.tabs, tab] })
}
export function closeTab(id: string | null, tab: DockTab) {
  const current = getDock(id)
  const tabs = current.tabs.filter((t) => t !== tab)
  setDock(id, { tabs, tab: current.tab === tab ? tabs[Math.min(current.tabs.indexOf(tab), tabs.length - 1)] ?? null : current.tab })
}

export const DOCK_MIN = 416 // desktop App.tsx: RIGHT_DOCK_MIN_WIDTH
/** `sidebarWidth` is the thread panel's current width, 0 while it is closed. */
export function dockGeometry(windowWidth: number, sidebarWidth: number, preferred: number) {
  const available = Math.max(0, windowWidth - 52 - 8 - sidebarWidth)
  const overlay = available < DOCK_MIN + 320
  const max = Math.max(0, overlay ? available : available - 320)
  return { overlay, max, width: Math.min(max, Math.max(DOCK_MIN, preferred)) }
}

export interface DockDrag { id: string | null; x: number; width: number; max: number }
let drag: DockDrag | null = null
export function startDockDrag(value: DockDrag) { drag = value; emit() }
export function finishDockDrag() { if (drag) { drag = null; emit() } }
export function useDockDrag() { return useSyncExternalStore(subscribe, () => drag) }
export function moveDockDrag(x: number) {
  if (drag) setDock(drag.id, { width: Math.min(drag.max, Math.max(DOCK_MIN, drag.width + drag.x - x)) })
}
