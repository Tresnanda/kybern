// This process's window in the window registry, and its title. The desktop
// titles every window "<environment> — Kybern" when it selects an environment
// (`lib/environments.ts` `selectEnvironment`).
import type { NativeRenderer } from '@gpuix/react'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { focusAppWindow } from '../shell/window.ts'
import { publishWindow, startWindowRegistry } from './registry.ts'

export const windowTitle = (name: string) => `${name} — Kybern`

let started = false
export function startEnvironmentWindow(renderer: NativeRenderer) {
  if (started) return
  started = true
  const title = () => { try { (renderer as { setWindowTitle?: (title: string) => void }).setWindowTitle?.(windowTitle(activeEnvironment().name)) } catch { /* keeps "Kybern" */ } }
  title()
  startWindowRegistry({ environment: () => ({ id: activeEnvironment().id, name: activeEnvironment().name }), focus: () => focusAppWindow(renderer) })
  onEnvironmentChange(() => { title(); publishWindow() }, 50)
}
