// FILE: flip.ts
// Purpose: Slide list items to their new place after a reorder or removal (FLIP), transform only.
// Layer: UI motion hook
// Exports: useFlipList, FLIP_MS, FLIP_EASING
//
// Mark each item with `data-flip-key="<stable id>"`, then call `capture()` in the event
// handler right before the state update that reorders or removes rows:
//
//   const list = useRef<HTMLUListElement>(null)
//   const { capture } = useFlipList(list)
//   const archive = (id: string) => { capture(); removeThread(id) }
//   <ul ref={list}>{rows.map((r) => <li key={r.id} data-flip-key={r.id}>…</li>)}</ul>
//
// The next commit measures the same keys again and plays a 250 ms translate from the old
// place to the new one on every row that moved (rows that were removed or are new are left to
// their own enter/exit). Pointer-triggered changes only: a keyboard action, reduced motion
// or a container with no capture does nothing. Never use it inside `VirtualRows`, which
// positions rows itself; keep it on short, unvirtualised lists (at most `max` rows animate).

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react"

import { lastInputWasPointer } from "@/lib/navMotion"

export const FLIP_MS = 250
export const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)"

const DEFAULT_SELECTOR = "[data-flip-key]"
const DEFAULT_MAX = 40
/** Moves under half a pixel are rounding noise. */
const MIN_MOVE_PX = 0.5

const running = new WeakMap<HTMLElement, Animation>()

type Positions = Map<string, { left: number; top: number }>

/** A capture that is not consumed by the next commit this soon is stale (the update never came). */
const CAPTURE_TTL_MS = 600

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function candidates(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector))
}

function intersectsViewport(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
}

export function useFlipList<T extends HTMLElement>(
  ref: RefObject<T | null>,
  opts?: { selector?: string; max?: number },
): { capture(): void } {
  const pending = useRef<{ positions: Positions; at: number } | null>(null)
  const selector = opts?.selector ?? DEFAULT_SELECTOR
  const max = opts?.max ?? DEFAULT_MAX
  const options = useRef({ selector, max })
  useLayoutEffect(() => {
    options.current = { selector, max }
  }, [selector, max])

  const capture = useCallback(() => {
    pending.current = null
    const container = ref.current
    if (!container || typeof container.animate !== "function") return
    if (!lastInputWasPointer() || prefersReducedMotion()) return
    const positions: Positions = new Map()
    for (const el of candidates(container, options.current.selector)) {
      if (positions.size >= options.current.max) break
      const key = el.dataset.flipKey
      if (!key) continue
      // getBoundingClientRect includes a transform still running from an earlier move, so an
      // interrupted slide continues from where the row is painted instead of jumping.
      const rect = el.getBoundingClientRect()
      if (intersectsViewport(rect)) positions.set(key, { left: rect.left, top: rect.top })
    }
    pending.current = positions.size > 0 ? { positions, at: performance.now() } : null
  }, [ref])

  // No dependency list: a capture can be followed by any render of the host.
  useLayoutEffect(() => {
    const captured = pending.current
    if (!captured) return
    pending.current = null
    if (performance.now() - captured.at > CAPTURE_TTL_MS) return
    const before = captured.positions
    const container = ref.current
    if (!container) return
    const items = candidates(container, options.current.selector)
    // Drop in-flight slides first so the measurement below is the layout position.
    for (const el of items) {
      running.get(el)?.cancel()
      running.delete(el)
    }
    if (!lastInputWasPointer() || prefersReducedMotion()) return
    const moved: Array<{ el: HTMLElement; dx: number; dy: number }> = []
    for (const el of items) {
      const key = el.dataset.flipKey
      const from = key ? before.get(key) : undefined
      if (!from) continue
      const rect = el.getBoundingClientRect()
      const dx = from.left - rect.left
      const dy = from.top - rect.top
      if (Math.abs(dx) >= MIN_MOVE_PX || Math.abs(dy) >= MIN_MOVE_PX) moved.push({ el, dx, dy })
    }
    for (const { el, dx, dy } of moved) {
      const animation = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: FLIP_MS, easing: FLIP_EASING })
      running.set(el, animation)
      const done = () => {
        if (running.get(el) === animation) running.delete(el)
      }
      animation.addEventListener("finish", done)
      animation.addEventListener("cancel", done)
    }
  })

  return { capture }
}
