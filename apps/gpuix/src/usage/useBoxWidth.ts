// A box's laid-out width, for paint-only fills that need a length in px (`MeterFill`). The native layout observer reports the size
// after the first paint and then only changes, so no timer or polling runs.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { observeElementBounds } from '../native/layout.ts'

export function useBoxWidth(): [RefObject<PublicInstance | null>, number] {
  const renderer = useGpuixRequired()
  const ref = useRef<PublicInstance | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const id = ref.current?.id
    if (id == null) return
    const take = (next: number | undefined) => { if (next && next > 0) setWidth(current => (Math.abs(current - next) < 0.5 ? current : next)) }
    take(renderer.getElementBounds?.(id)?.width)
    return observeElementBounds(renderer, id, event => take(event.rect?.width))
  }, [renderer])
  return [ref, width]
}
