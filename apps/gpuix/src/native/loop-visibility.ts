import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isWindowVisible, onWindowVisibility } from './visibility.ts'
import { observeElementBounds, type ElementBoundsEvent } from './layout.ts'

/** Paint observers do not schedule frames. Buffered and retained rows can stay
 * mounted outside the clip; only crossing its edge changes React state. */
export function hasVisiblePaint({rect, clippedRect:clip}: Pick<ElementBoundsEvent, 'rect' | 'clippedRect'>): boolean {
  return !!rect && !!clip && rect.width > 0 && rect.height > 0 && clip.width > 0 && clip.height > 0
    && rect.x < clip.x + clip.width && rect.y < clip.y + clip.height
    && clip.x < rect.x + rect.width && clip.y < rect.y + rect.height
}
/** All of the element is painted inside its clip (a list edge does not cut it). */
export function hasWholePaint({rect, clippedRect:clip}: Pick<ElementBoundsEvent, 'rect' | 'clippedRect'>): boolean {
  return !!rect && !!clip && rect.width > 0 && rect.height > 0 && clip.width >= rect.width - 0.5 && clip.height >= rect.height - 0.5
}
/** `whole`: visible only while nothing clips it (`hasWholePaint`). */
export function useLoopVisibility(active = true, whole = false) {
  const renderer = useGpuix()?.renderer
  const canObserve = typeof (renderer as {addLayoutObserver?: unknown} | undefined)?.addLayoutObserver === 'function'
  const ref = useRef<PublicInstance | null>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!active || !renderer || !ref.current || !canObserve) return
    return observeElementBounds(renderer, ref.current.id, event => {
      const next = whole ? hasWholePaint(event) : hasVisiblePaint(event)
      setVisible(old => old === next ? old : next)
    })
  }, [renderer, canObserve, active, whole])
  // Stock addon has no paint observer; retain its previous behavior.
  return { ref, visible: active && (!canObserve || visible) }
}

/** `useLoopVisibility` plus window visibility: `running` is when a native paint loop should be on. Native loops
 * present frames until their prop is removed, so a covered, minimized or other-Space window must drop it; the
 * visibility poll (`visibility.ts`) runs only while such a loop is painted. */
export function useLoopRunning(active = true, whole = false) {
  const loop = useLoopVisibility(active, whole)
  const subscribe = useCallback((listener: () => void) => loop.visible ? onWindowVisibility(listener) : () => {}, [loop.visible])
  const shown = useSyncExternalStore(subscribe, isWindowVisible)
  return { ref: loop.ref, visible: loop.visible, running: loop.visible && shown }
}
