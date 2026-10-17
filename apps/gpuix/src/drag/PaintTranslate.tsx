import { forwardRef, useRef, type ReactNode } from 'react'
import type { MotionStyle, MotionTransition, Props, PublicInstance, StyleDesc } from '@gpuix/react'

/** Native retained-scene translation. Layout slots and React children stay fixed. */
export const PaintTranslate = forwardRef<PublicInstance, {
  animate: Pick<MotionStyle, 'translateX' | 'translateY'>
  initial?: false | Pick<MotionStyle, 'translateX' | 'translateY'>
  transition?: MotionTransition
  onMotionComplete?: Props['onMotionComplete']
  style?: StyleDesc
  testId?: string
  children?: ReactNode
}>(function PaintTranslate({ animate, initial = false, transition, onMotionComplete, ...props }, ref) {
  const generation = useRef(0)
  const previous = useRef('')
  const key = JSON.stringify([animate, transition])
  if (previous.current !== key) { previous.current = key; generation.current++ }
  const paintTranslate = { initial, animate, transition, generation: generation.current }
  return <div {...props} ref={ref} onMotionComplete={onMotionComplete ? event => {
    if (event.motionGeneration === generation.current) onMotionComplete?.(event)
  } : undefined} paintTranslate={paintTranslate} />
})
