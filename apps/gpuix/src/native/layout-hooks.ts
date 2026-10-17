import { useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { onWindowResize, observeElementBounds, type ElementBoundsEvent, type WindowResizeEvent } from './layout.ts'

/** One startup read, then post-paint native events. */
export function useNativeWindowSize(): WindowResizeEvent {
  const renderer = useGpuixRequired()
  const [size, setSize] = useState<WindowResizeEvent>(() => ({ ...renderer.getWindowSize!(), scaleFactor: 1, frame: 0 }))
  useEffect(() => onWindowResize(renderer, setSize), [renderer])
  return size
}

/** Subscribe after mounting a unique test ID. Null while unpainted/unmounted. */
export function useElementBounds(testId: string): ElementBoundsEvent | null {
  const renderer = useGpuixRequired()
  const [event, setEvent] = useState<ElementBoundsEvent | null>(null)
  useEffect(() => observeElementBounds(renderer, { testId }, setEvent), [renderer, testId])
  return event
}
