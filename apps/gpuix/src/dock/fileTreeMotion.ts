import type { MotionStyle, MotionTransition } from '@gpuix/react'
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from '../shared/lib/beui/ease.ts'

export const TREE_ROW_HEIGHT = 29
export const TREE_WINDOW_THRESHOLD = 100
export type TreeWindow = { start: number; end: number }
/** Keep a generous pixel-independent buffer, refilling before its edge is visible. */
export function treeWindowRange(count: number, first: number, last: number, current: TreeWindow): TreeWindow {
  const start = Math.max(0, Math.min(count, Math.floor(first)))
  const end = Math.max(start, Math.min(count, Math.ceil(last)))
  if (start >= current.start + (current.start === 0 ? 0 : 24) && end <= current.end - (current.end >= count ? 0 : 24)) return current
  return { start: Math.max(0, start - 64), end: Math.min(count, Math.max(end, start + 64) + 64) }
}
export const TREE_ENTER = { duration: 0.22, ease: [...EASE_OUT] as [number, number, number, number] }
export const TREE_BRANCH = { duration: 0.3, ease: [...EASE_OUT] as [number, number, number, number] }

// clip7 supplies native SVG rotation and the desktop's physical springs.
// Query capabilities so an older addon can still render a usable tree.
export function treeMotionCapabilities(renderer: object) {
  const native = renderer as { getMotionCapabilities?: () => { rotate?: boolean; physicalSprings?: boolean } }
  const capabilities = native.getMotionCapabilities?.()
  const enabled = process.env.KYBERN_NATIVE_PHYSICAL_MOTION === '1'
  return { rotate: capabilities?.rotate ?? enabled, physical: capabilities?.physicalSprings ?? enabled }
}
export type TreeMotionStyle = MotionStyle & { rotate?: number }
export function treeSpring(kind: 'layout' | 'swap', physical: boolean): MotionTransition {
  const spring = kind === 'layout' ? SPRING_LAYOUT : SPRING_SWAP
  return physical ? { ...spring } : { type: 'spring', duration: 0.3, bounce: 0.05 }
}
