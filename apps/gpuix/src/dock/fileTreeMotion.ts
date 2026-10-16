import type { MotionStyle, MotionTransition } from '@gpuix/react'
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from '../../../desktop/src/lib/beui/ease.ts'

export const TREE_ROW_HEIGHT = 29
export const TREE_WINDOW_THRESHOLD = 100
export const TREE_ENTER = { duration: 0.22, ease: [...EASE_OUT] as [number, number, number, number] }
export const TREE_BRANCH = { duration: 0.3, ease: [...EASE_OUT] as [number, number, number, number] }

// clip7 supplies these additive native capabilities. The accepted round-6 addon
// only understands duration/bounce springs and cannot animate rotation. Keep
// that build usable; merged native capability exports enable exact physics.
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
