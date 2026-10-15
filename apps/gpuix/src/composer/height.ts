import { useGpuixRequired, type PublicInstance } from "@gpuix/react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { observeElementBounds } from "../native/layout.ts"

const measurements = new Map<object, { priority: number; height: number }>()
const listeners = new Set<() => void>()
let height = 0
function publish() {
  const priority = Math.max(-1, ...[...measurements.values()].map(value => value.priority))
  const next = Math.max(0, ...[...measurements.values()].filter(value => value.priority === priority).map(value => value.height))
  if (height === next) return
  height = next
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Zero while unmounted. No polling and safe to consume before an editor exists. */
export function useComposerOverlayHeight(): number {
  return useSyncExternalStore(subscribe, () => height)
}

/** Attach to the card (priority 0) or complete floating stack (priority 1).
 * The complete stack includes requests, subagent bars and its bottom gutter.
 * Native observers require an existing node, so the producer owns the observer.
 */
export function useMeasureComposerOverlay(priority = 0) {
  const renderer = useGpuixRequired()
  const owner = useRef({})
  const [node, setNode] = useState<PublicInstance | null>(null)
  useEffect(() => {
    if (!node) return
    const key = owner.current
    const stop = observeElementBounds(renderer, node.id, event => {
      if (event.rect) measurements.set(key, { priority, height: event.rect.height })
      else measurements.delete(key)
      publish()
    })
    return () => { stop(); measurements.delete(key); publish() }
  }, [renderer, node, priority])
  return setNode
}
