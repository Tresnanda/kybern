import { useCallback, useRef } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { observeElementBounds } from '../native/layout.ts'
import { readView, saveView } from './viewState.ts'

type Anchor = [number, number]

/** Exact native anchors, owned by each mounted viewport. No React work runs per wheel. */
export function useReadingPosition(viewKey: string | undefined, slot: string, ready = true) {
  const renderer = useGpuixRequired()
  const native = renderer as typeof renderer & { getListScrollTop?: (id: number) => number[] | null }
  const mounted = useRef<PublicInstance | null>(null)
  const anchor = useRef<Anchor | null>(null)
  const stop = useRef<(() => void) | null>(null)

  return useCallback((node: PublicInstance | null) => {
    stop.current?.()
    stop.current = null
    if (!node) {
      if (viewKey && ready && mounted.current) {
        const top = native.getListScrollTop?.(mounted.current.id)
        const position: Anchor | null = top ? [top[0]!, top[1]!] : anchor.current
        if (position) {
          const scroll = { ...readView(viewKey).scroll }
          delete scroll[slot]
          scroll[slot] = position
          for (const old of Object.keys(scroll).slice(0, -12)) delete scroll[old]
          saveView(viewKey, { scroll })
        }
      }
      mounted.current = null
      return
    }
    mounted.current = node
    anchor.current = null
    if (!viewKey || !ready) return
    let live = true
    let unsubscribe: (() => void) | undefined
    stop.current = () => { live = false; unsubscribe?.() }
    // React can replace a loading host again in the same commit. Attach after its native batch is applied;
    // a detached ref cancels this microtask instead of subscribing to an already deleted element.
    queueMicrotask(() => {
      if (!live) return
      const saved = readView(viewKey).scroll[slot]
      let restored = !saved
      unsubscribe = observeElementBounds(renderer, node.id, event => {
        if (!event.rect) return
        const top = event.scrollTop ?? native.getListScrollTop?.(node.id)
        if (!top) return
        if (!restored) {
          restored = true
          native.scrollToItem?.(node.id, saved![0], saved![1])
          return
        }
        anchor.current = [top[0]!, top[1]!]
      })
    })
  }, [renderer, viewKey, slot, ready])
}
