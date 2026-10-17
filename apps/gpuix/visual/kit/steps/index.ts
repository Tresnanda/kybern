// A state is one photographable moment of a gallery section: how to drive the desktop page (Playwright `page`)
// and the GPUIX app (automation `app`) into it. `section` names the gallery section; both drivers are optional
// (no driver = the resting section).
import type { App } from '@gpuix/react/automation'
export interface KitState {
  section: string
  /** Playwright page of the desktop gallery. */
  tauri?: (page: any) => Promise<void>
  /** Automation handle of the GPUIX gallery window. */
  gpuix?: (app: App) => Promise<void>
  /** Wait this long after the drivers (ms; default 500). */
  settle?: number
  /** Clip to this logical rect (x, y, w, h) when set; default the whole 1280 x 820 section. */
  clip?: [number, number, number, number]
}
import { states as hello } from './hello.ts'
export const states: Record<string, KitState> = { ...hello }
