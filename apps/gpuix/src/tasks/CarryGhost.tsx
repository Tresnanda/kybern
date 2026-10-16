import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { bindNativeCarry, type CarryStore } from '../drag/carry.ts'
import { DragGhost, type Rect, type Settle } from '../drag/Ghost.tsx'
import { ISLAND } from '../MatrixLoader.tsx'
import { TASK_DROP_MOTION } from './motion.ts'

/** Pointer motion never re-renders the held content. Landing keeps the existing native tween. */
export function TaskCarryGhost({ rect, x, y, grab, settle, store, pacing, onSettled, children }: {
  rect: Rect; x: number; y: number; grab: { x: number; y: number }; settle: Settle | null
  store: CarryStore; pacing?: (node: PublicInstance | null) => void; onSettled: () => void; children: ReactNode
}) {
  const renderer = useGpuixRequired()
  const node = useRef<PublicInstance | null>(null)
  useLayoutEffect(() => {
    if (!node.current) return
    return bindNativeCarry(renderer, node.current.id, { x: rect.x + grab.x, y: rect.y + grab.y }, store)
  }, [renderer, rect, grab, store])
  const left = x - grab.x, top = y - grab.y
  return <div ref={value => { node.current = value; pacing?.(value) }} testId="task-drag-ghost"
    style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, pointerEvents: 'none' }}>
    <DragGhost bare landing={TASK_DROP_MOTION} rect={{ x: 0, y: 0, width: rect.width, height: rect.height }} grab={grab}
      x={grab.x} y={grab.y} settle={settle ? { ...settle, to: { x: settle.to.x - left, y: settle.to.y - top } } : null} onSettled={onSettled}>
      <div {...ISLAND} style={{ width: rect.width, height: rect.height, pointerEvents: 'none' }}>{children}</div>
    </DragGhost>
  </div>
}
