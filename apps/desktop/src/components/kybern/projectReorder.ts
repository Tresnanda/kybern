// Drag sidebar projects into a new order. Same approach as thread drags
// (pointer capture instead of HTML DataTransfer, which WKWebView promotes
// unreliably): the grabbed project follows the pointer 1:1 from where it was
// grabbed, the projects it passes slide aside, and on release every row
// settles from where it is on screen, so nothing jumps.

import type { PointerEvent as ReactPointerEvent } from "react"
import { flushSync } from "react-dom"

import type { ProjectId } from "@/protocol"
import { dropIndex } from "@/state/sidebarOrganize"

const DRAG_THRESHOLD = 6
/** Distance from the list viewport's edge where dragging starts scrolling. */
const EDGE_ZONE = 48
const EDGE_SPEED = 14
const SETTLE_MS = 250
const SETTLE = ["transform", "box-shadow", "background-color"].map((property) => `${property} var(--duration-fast) var(--ease-out)`).join(", ")

let suppressedClick: { id: ProjectId; until: number } | null = null
let cancelActive: (() => void) | null = null

/** True once for the click that ends a drag, so releasing does not also open the project. */
export function consumeProjectDragClick(id: ProjectId): boolean {
  if (!suppressedClick || suppressedClick.id !== id) return false
  const suppress = performance.now() <= suppressedClick.until
  suppressedClick = null
  return suppress
}

export interface ProjectReorder {
  event: ReactPointerEvent<HTMLElement>
  id: ProjectId
  /** Commit the move. Called inside `flushSync` so the new order is laid out before rows settle. */
  onDrop: (id: ProjectId, targetIndex: number, visible: ProjectId[]) => void
}

/** Start tracking a possible drag from a project header. Rows carry `data-project-id` on their list item. */
export function beginProjectReorder({ event, id, onDrop }: ProjectReorder): void {
  if (event.button !== 0 || !event.isPrimary) return
  const handle = event.currentTarget
  const item = handle.closest<HTMLElement>("[data-project-id]")
  const list = item?.parentElement
  if (!item || !list) return
  cancelActive?.()

  const pointerId = event.pointerId
  const scroller = scrollParent(list)
  const scrollTop = () => scroller?.scrollTop ?? 0
  const startX = event.clientX
  const startY = event.clientY
  const startContentY = startY + scrollTop()
  let clientY = startY
  let dragging = false
  let finished = false
  let frame = 0
  let rows: HTMLElement[] = []
  let from = 0
  let target = 0
  let step = 0
  let draggedMidpoint = 0
  let midpoints: number[] = []
  const instant = matchMedia("(prefers-reduced-motion: reduce)").matches

  const start = () => {
    dragging = true
    rows = [...list.children].filter((row): row is HTMLElement => row instanceof HTMLElement && !!row.dataset.projectId)
    from = rows.indexOf(item)
    target = from
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0
    const top = (row: HTMLElement) => row.getBoundingClientRect().top + scrollTop()
    step = item.offsetHeight + gap
    draggedMidpoint = top(item) + item.offsetHeight / 2
    midpoints = rows.filter((row) => row !== item).map((row) => top(row) + row.offsetHeight / 2)
    for (const row of rows) row.style.transition = row === item || instant ? "none" : SETTLE
    item.dataset.projectReorder = "lifted"
    document.documentElement.dataset.projectReordering = "true"
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      // Capture is best-effort in older embedded WebKit builds.
    }
    frame = requestAnimationFrame(edgeScroll)
  }

  const layout = () => {
    const dy = clientY + scrollTop() - startContentY
    item.style.transform = `translate3d(0, ${dy}px, 0)`
    target = dropIndex(midpoints, draggedMidpoint + dy)
    rows.forEach((row, index) => {
      if (row === item) return
      const other = index < from ? index : index - 1
      const next = other < target ? other : other + 1
      row.style.transform = next === index ? "" : `translate3d(0, ${(next - index) * step}px, 0)`
    })
  }

  // Scroll while the pointer rests near the viewport's edge, faster the
  // closer it gets, keeping the grabbed row under the pointer.
  function edgeScroll() {
    if (!dragging || finished) return
    if (scroller) {
      const bounds = scroller.getBoundingClientRect()
      const above = bounds.top + EDGE_ZONE - clientY
      const below = clientY - (bounds.bottom - EDGE_ZONE)
      const speed = above > 0 ? -Math.min(1, above / EDGE_ZONE) : below > 0 ? Math.min(1, below / EDGE_ZONE) : 0
      if (speed !== 0) {
        const before = scroller.scrollTop
        scroller.scrollTop += speed * EDGE_SPEED
        if (scroller.scrollTop !== before) layout()
      }
    }
    frame = requestAnimationFrame(edgeScroll)
  }

  const cleanup = () => {
    cancelAnimationFrame(frame)
    window.removeEventListener("pointermove", onMove, true)
    window.removeEventListener("pointerup", onUp, true)
    window.removeEventListener("pointercancel", onCancel, true)
    window.removeEventListener("keydown", onKey, true)
    window.removeEventListener("blur", onCancel)
    delete document.documentElement.dataset.projectReordering
    try {
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
    } catch {
      // Released already.
    }
  }

  const finish = (drop: boolean) => {
    if (finished) return
    finished = true
    cleanup()
    cancelActive = null
    if (!dragging) return
    suppressedClick = { id, until: performance.now() + 500 }

    // FLIP: remember where every row is on screen, commit the order, then
    // let each row glide from there to its new resting place.
    const before = new Map(rows.map((row) => [row, row.getBoundingClientRect().top]))
    for (const row of rows) {
      row.style.transition = "none"
      row.style.transform = ""
    }
    if (drop && target !== from) {
      const visible = rows.map((row) => row.dataset.projectId as ProjectId)
      flushSync(() => onDrop(id, target, visible))
    }
    for (const row of rows) {
      const delta = (before.get(row) ?? 0) - row.getBoundingClientRect().top
      if (Math.abs(delta) > 0.5) row.style.transform = `translate3d(0, ${delta}px, 0)`
    }
    void list.offsetHeight
    for (const row of rows) {
      row.style.transition = instant ? "none" : SETTLE
      row.style.transform = ""
    }
    // The shadow fades as the row lands, then inline styles are removed.
    delete item.dataset.projectReorder
    window.setTimeout(() => {
      for (const row of rows) if (!row.style.transform) row.style.transition = ""
    }, instant ? 0 : SETTLE_MS)
  }

  function onMove(pointer: PointerEvent) {
    if (pointer.pointerId !== pointerId) return
    clientY = pointer.clientY
    if (!dragging) {
      if (Math.hypot(pointer.clientX - startX, clientY - startY) < DRAG_THRESHOLD) return
      start()
    }
    pointer.preventDefault()
    layout()
  }
  function onUp(pointer: PointerEvent) {
    if (pointer.pointerId === pointerId) finish(true)
  }
  function onCancel() {
    finish(false)
  }
  function onKey(key: KeyboardEvent) {
    if (key.key !== "Escape" || !dragging) return
    key.preventDefault()
    key.stopPropagation()
    finish(false)
  }

  window.addEventListener("pointermove", onMove, true)
  window.addEventListener("pointerup", onUp, true)
  window.addEventListener("pointercancel", onCancel, true)
  window.addEventListener("keydown", onKey, true)
  window.addEventListener("blur", onCancel)
  cancelActive = () => finish(false)
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node
  }
  return null
}
