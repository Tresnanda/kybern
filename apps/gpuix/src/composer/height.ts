import { usePaneAccess, useApp } from '../state.ts'
import { useGpuixRequired, type PublicInstance } from "@gpuix/react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { observeElementBounds, type LayoutRect } from "../native/layout.ts"
import { webHost } from '../native/webview.ts'

const measurements = new Map<object, { priority: number; height: number; pane: string }>()
const cards = new Map<object, LayoutRect>()
/** Where composer cards are on screen (window points): a live visual turns back into its picture before it slides under one. */
export const composerCardRects = (): LayoutRect[] => [...cards.values()]
const listeners = new Set<() => void>()
let height = 0
function publish() {
  const priority = Math.max(-1, ...[...measurements.values()].map(value => value.priority))
  const next = Math.max(0, ...[...measurements.values()].filter(value => value.priority === priority).map(value => value.height))
  height = next
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Zero while unmounted. No polling and safe to consume before an editor exists. */
export function useComposerOverlayHeight(): number {
  const pane = usePaneAccess()
  useApp(s => s.selectedId)
  return useSyncExternalStore(subscribe, () => {
    const own = [...measurements.values()].filter(value => value.pane === pane.id)
    const priority = Math.max(-1, ...own.map(value => value.priority))
    return Math.max(0, ...own.filter(value => value.priority === priority).map(value => value.height))
  })
}

/** Attach to the card (priority 0) or complete floating stack (priority 1).
 * The complete stack includes requests, subagent bars and its bottom gutter.
 * Native observers require an existing node, so the producer owns the observer.
 */
export function useMeasureComposerOverlay(priority = 0) {
  const pane = usePaneAccess()
  const renderer = useGpuixRequired()
  const owner = useRef({})
  const [node, setNode] = useState<PublicInstance | null>(null)
  useEffect(() => {
    if (!node || pane.frozen) return
    const key = owner.current
    const stop = observeElementBounds(renderer, node.id, event => {
      if (priority === 0) webHost.occlusion(-node.id, event.clippedRect, 24, 0, 1)
      if (priority === 0) { if (event.clippedRect) cards.set(key, event.clippedRect); else cards.delete(key) }
      if (event.rect) measurements.set(key, { priority, height: event.rect.height, pane: pane.id })
      else measurements.delete(key)
      publish()
    })
    return () => { stop(); if (priority === 0) webHost.occlusion(-node.id, null); cards.delete(key); measurements.delete(key); publish() }
  }, [renderer, node, priority, pane])
  return setNode
}
