import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { observeElementBounds, type ElementBoundsEvent } from './layout.ts'

/** Paint observers do not schedule frames. Buffered and retained rows can stay
 * mounted outside the clip; only crossing its edge changes React state. */
export function hasVisiblePaint({rect, clippedRect:clip}: Pick<ElementBoundsEvent, 'rect' | 'clippedRect'>): boolean {
  return !!rect && !!clip && rect.width > 0 && rect.height > 0 && clip.width > 0 && clip.height > 0
    && rect.x < clip.x + clip.width && rect.y < clip.y + clip.height
    && clip.x < rect.x + rect.width && clip.y < rect.y + rect.height
}
export function useLoopVisibility(active = true) {
  const renderer = useGpuix()?.renderer
  const canObserve = typeof (renderer as {addLayoutObserver?: unknown} | undefined)?.addLayoutObserver === 'function'
  const ref = useRef<PublicInstance | null>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!active || !renderer || !ref.current || !canObserve) return
    return observeElementBounds(renderer, ref.current.id, event => {
      const next = hasVisiblePaint(event)
      setVisible(old => old === next ? old : next)
    })
  }, [renderer, canObserve, active])
  // Stock addon has no paint observer; retain its previous behavior.
  return { ref, visible: active && (!canObserve || visible) }
}
