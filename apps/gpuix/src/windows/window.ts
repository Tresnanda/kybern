// This process's window in the window registry, and its title: "<machine> — Kybern", the machine the user is at.
import type { NativeRenderer } from '@gpuix/react'
import { activeEnvironment } from '../shell/environment.ts'
import { focusAppWindow } from '../shell/window.ts'
import { startWindowRegistry } from './registry.ts'

export const windowTitle = (name: string) => `${name} — Kybern`

let started = false
export function startEnvironmentWindow(renderer: NativeRenderer) {
  if (started) return
  started = true
  try { (renderer as { setWindowTitle?: (title: string) => void }).setWindowTitle?.(windowTitle(activeEnvironment().name)) } catch { /* keeps "Kybern" */ }
  startWindowRegistry({ name: () => activeEnvironment().name, focus: () => focusAppWindow(renderer) })
}
