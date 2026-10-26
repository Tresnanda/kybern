// Reduce Motion (System Settings › Accessibility › Display) as a live binding: `REDUCED_MOTION`, re-exported by ui.tsx.
// Read at startup, then updated by the accessibility poll (`platform/material.ts`), so every motion that starts after a
// change takes its fade or instant path. Read it when a motion starts, never into a module constant. No app imports,
// so it is initialised before any module reads it. `KYBERN_REDUCED_MOTION` pins it.
// Windows' "Animation effects" (SPI_GETCLIENTAREAANIMATION) arrives from the addon once the window is up, GNOME's
// `enable-animations` is read here and followed by `shell/windowChrome.ts`.
import { spawnSync } from 'node:child_process'
import { readLinuxReducedMotion } from './systemPrefs.ts'

function startup(): boolean {
  if (process.env.KYBERN_REDUCED_MOTION) return process.env.KYBERN_REDUCED_MOTION === '1'
  if (process.platform === 'linux') return readLinuxReducedMotion() ?? false
  if (process.platform !== 'darwin') return false
  const r = spawnSync('defaults', ['read', 'com.apple.universalaccess', 'reduceMotion'], { encoding: 'utf8' })
  return r.stdout?.trim() === '1'
}

export let REDUCED_MOTION = startup()
export function setReducedMotion(value: boolean) { REDUCED_MOTION = value }
