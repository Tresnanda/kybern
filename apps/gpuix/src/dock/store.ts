import { load, save } from '../shell/persist.ts'
import { onEnvironmentChange, onEnvironmentLeaving } from '../shell/environment.ts'
// Dock choices belong to the selected thread; closing a tab discards its content.
// Bounded per-environment layout preferences survive ordinary app exits.
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
const DEFAULT: DockState = { open: false, tabs: [], tab: null, width: 538, instant: false }
// Terminal, preview and review were viewer panels; since ADE-54 they open as tabs beside the chat, so saved choices drop them.
const TABS: DockTab[] = ['agents', 'activity', 'changes', 'explorer', 'project', 'notes', 'tasks', 'artifacts']
export function restoreDockChoices(value: unknown): Map<string, DockState> {
  const restored = new Map<string, DockState>()
  if (!Array.isArray(value)) return restored
  for (const entry of value.slice(-80)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object') continue
    const [key, item] = entry
    const tabs = Array.isArray(item.tabs) ? [...new Set(item.tabs.filter((tab: DockTab) => TABS.includes(tab)))] as DockTab[] : DEFAULT.tabs
    restored.set(key, { open: item.open === true, tabs, tab: tabs.includes(item.tab) ? item.tab : tabs[0] ?? null, width: typeof item.width === 'number' && Number.isFinite(item.width) ? Math.max(416, Math.min(1600, item.width)) : DEFAULT.width, instant: false })
  }
  return restored
}
const choices = restoreDockChoices(load('kybern.dock.choices', []))
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const getDock = (id: string | null) => choices.get(id ?? 'home') ?? DEFAULT
export function useDock(id: string | null) { return useSyncExternalStore(subscribe, () => getDock(id)) }
export function setDock(id: string | null, patch: Partial<DockState>) {
  const key = id ?? 'home'
  if (!choices.has(key) && choices.size >= 80) choices.delete(choices.keys().next().value!)
  choices.set(key, { ...getDock(id), ...patch })
  save('kybern.dock.choices', [...choices].map(([key, value]) => [key, { ...value, instant: false }]))
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

export function moveTab(id: string | null, tab: DockTab, to: number) {
  const current = getDock(id)
  const tabs = current.tabs.filter((t) => t !== tab)
  tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, tab)
  setDock(id, { tabs })
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

onEnvironmentLeaving(() => save('kybern.dock.choices', [...choices]))
onEnvironmentChange(() => { choices.clear(); for (const [id, value] of restoreDockChoices(load('kybern.dock.choices', []))) choices.set(id, value); drag = null; emit() })
