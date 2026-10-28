import { REDUCED_MOTION } from '../ui.tsx'
import { useSyncExternalStore } from 'react'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'

interface Panel { threadId: string; leaving: boolean; keyboard: boolean; generation: number }
/** The thread content's window rect (the desktop's `inset-y-0 right-0 p-3` container), published by the focused pane. */
export interface DockRect { x: number; y: number; width: number; height: number }
let panel: Panel | null = null
let dockRect: DockRect | null = null
let generation = 3_000_000
let timer: ReturnType<typeof setTimeout> | undefined
let stopVisibility: (() => void) | undefined
function clearCloseRecovery() {
  clearTimeout(timer)
  timer = undefined
  stopVisibility?.()
  stopVisibility = undefined
}
// Retain the close policy after unmount, so a batched immediate close cannot
// turn the content inset into an animated 312→0 transition.
let instant = REDUCED_MOTION
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
export function useEnvironmentPanel() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => panel) }
export function useEnvironmentInstant() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => instant) }
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
  clearCloseRecovery()
  instant = REDUCED_MOTION || keyboard
  panel = { threadId, keyboard, leaving: false, generation: ++generation }
  emit()
}
export function closeEnvironmentPanel(immediate = false) {
  if (!panel) return
  clearCloseRecovery()
  if (immediate || instant) { instant = true; panel = null; emit(); return }
  panel = { ...panel, leaving: true, generation: ++generation }
  emit()
  const closing = panel.generation
  // Native completion owns the visible exit. A wall-clock 300ms unmount can
  // truncate it when a busy frame delays the start; keep a recovery bound for
  // occluded windows whose native animation clock is parked.
  const deadline = performance.now() + 900
  const recover = () => { if (!isWindowVisible()) finishEnvironmentClose(closing) }
  timer = setTimeout(recover, 900)
  stopVisibility = onWindowVisibility(visible => {
    if (visible) return
    clearTimeout(timer)
    timer = setTimeout(recover, Math.max(0, deadline - performance.now()))
  })
}

export function finishEnvironmentClose(closing: number) {
  if (!panel?.leaving || panel.generation !== closing) return
  clearCloseRecovery()
  panel = null
  emit()
}

