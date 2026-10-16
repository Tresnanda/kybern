import { REDUCED_MOTION } from '../ui.tsx'
import { onEnvironmentChange } from '../shell/environment.ts'
import { useSyncExternalStore } from 'react'

interface Panel { threadId: string; leaving: boolean; keyboard: boolean; generation: number }
/** The thread content's window rect (the desktop's `inset-y-0 right-0 p-3` container), published by the focused pane. */
export interface DockRect { x: number; y: number; width: number; height: number }
let panel: Panel | null = null
let dockRect: DockRect | null = null
let generation = 3_000_000
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
export function useEnvironmentPanel() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => panel) }
export function useEnvironmentDock() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => dockRect) }
export function setEnvironmentDock(next: DockRect | null) {
  if (dockRect === next || (dockRect && next && dockRect.x === next.x && dockRect.y === next.y && dockRect.width === next.width && dockRect.height === next.height)) return
  dockRect = next
  emit()
}
/** Content inset while the panel is docked (`ENVIRONMENT_DOCKED_CONTENT_INSET_PX`). */
export const DOCKED_INSET = 312
/** composerPickerStyles.ts: Environment slide and content inset share the drawer curve. */
export const ENVIRONMENT_MOTION = { duration: 0.3, ease: [0.32, 0.72, 0, 1] as [number, number, number, number] }
export function openEnvironmentPanel(threadId: string, keyboard: boolean) {
  clearTimeout(timer)
  panel = { threadId, keyboard, leaving: false, generation: ++generation }
  emit()
}
export function closeEnvironmentPanel(immediate = false) {
  if (!panel) return
  clearTimeout(timer)
  if (immediate) { panel = null; emit(); return }
  panel = { ...panel, leaving: true, generation: ++generation }
  emit()
  timer = setTimeout(() => { panel = null; emit() }, REDUCED_MOTION || panel.keyboard ? 0 : ENVIRONMENT_MOTION.duration * 1000)
}

onEnvironmentChange(() => closeEnvironmentPanel(true))
