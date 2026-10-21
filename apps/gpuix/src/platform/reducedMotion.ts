// Reduce Motion (System Settings › Accessibility › Display) as a live binding: `REDUCED_MOTION`, re-exported by ui.tsx.
// Read at startup, then updated by the accessibility poll (`platform/material.ts`), so every motion that starts after a
// change takes its fade or instant path. Read it when a motion starts, never into a module constant. No app imports,
// so it is initialised before any module reads it. `KYBERN_REDUCED_MOTION` pins it.
import { spawnSync } from 'node:child_process'

function startup(): boolean {
  if (process.env.KYBERN_REDUCED_MOTION) return process.env.KYBERN_REDUCED_MOTION === '1'
  const r = spawnSync('defaults', ['read', 'com.apple.universalaccess', 'reduceMotion'], { encoding: 'utf8' })
  return r.stdout?.trim() === '1'
}

export let REDUCED_MOTION = startup()
export function setReducedMotion(value: boolean) { REDUCED_MOTION = value }
