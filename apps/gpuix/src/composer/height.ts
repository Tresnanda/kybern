import { usePaneAccess, useApp } from '../state.ts'
import { useGpuixRequired, type PublicInstance } from "@gpuix/react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { observeElementBounds, type LayoutRect } from "../native/layout.ts"
import { webHost } from '../native/webview.ts'
import { useChatHidden } from '../tabs/hidden.ts'

const measurements = new Map<object, { priority: number; height: number; pane: string }>()
const cards = new Map<object, { rect: LayoutRect; pane: string }>()
const stacks = new Map<object, { rect: LayoutRect; pane: string }>()
/**
 * Where composer cards are on screen (window points), each grown to its pane's floating stack: the requests above it and
 * the gutter below, across the card's width. A live visual turns back into its picture before it slides under any of it;
 * the native page is cut out only under the card itself, so a page left live under a request bar or in the gutter showed
 * through there (seen on Windows).
 */
export const composerCardRects = (): LayoutRect[] => [...cards.values()].map(({ rect, pane }) => {
  const stack = [...stacks.values()].find(value => value.pane === pane)?.rect
  if (!stack) return rect
  const y = Math.min(rect.y, stack.y), bottom = Math.max(rect.y + rect.height, stack.y + stack.height)
  return { ...rect, y, height: bottom - y }
})
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
  // A chat kept mounted under a document tab is invisible: its card must not cut a hole in that tab's web page.
  const hidden = useChatHidden()
  useEffect(() => {
    if (!node || pane.frozen) return
    const key = owner.current
    const stop = observeElementBounds(renderer, node.id, event => {
      const shown = hidden ? null : event.clippedRect
      if (priority === 0) webHost.occlusion(-node.id, shown, 24, 0, 1)
      const floating = priority === 0 ? cards : stacks
      if (shown) floating.set(key, { rect: shown, pane: pane.id }); else floating.delete(key)
      if (event.rect) measurements.set(key, { priority, height: event.rect.height, pane: pane.id })
      else measurements.delete(key)
      publish()
    })
    return () => { stop(); if (priority === 0) webHost.occlusion(-node.id, null); cards.delete(key); stacks.delete(key); measurements.delete(key); publish() }
  }, [renderer, node, priority, pane, hidden])
  return setNode
}
