import { onEnvironmentChange } from '../shell/environment.ts'
import { useSyncExternalStore } from 'react'

interface Panel { threadId: string; x: number; y: number; leaving: boolean; keyboard: boolean; generation: number }
let panel: Panel | null = null
let generation = 3_000_000
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
export function useEnvironmentPanel() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => panel) }
export function openEnvironmentPanel(threadId: string, x: number, y: number, keyboard: boolean) {
  clearTimeout(timer)
  panel = { threadId, x, y, keyboard, leaving: false, generation: ++generation }
  emit()
}
export function closeEnvironmentPanel(immediate = false) {
  if (!panel) return
  clearTimeout(timer)
  if (immediate) { panel = null; emit(); return }
  panel = { ...panel, leaving: true, generation: ++generation }
  emit()
  timer = setTimeout(() => { panel = null; emit() }, 120)
}

onEnvironmentChange(() => closeEnvironmentPanel(true))
