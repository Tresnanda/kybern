// `components/kybern/ResizeHandle.tsx` + `lib/hooks.ts` `useResize`: a drag handle between two panes (a 16px invisible hit
// area straddling the seam and a 2px line that appears on hover, keyboard focus or while dragging) and the hook that owns the
// pane's width (min/max clamp, optional persistence, keyboard steps, double-click reset).
//
// GPUIX delivers mouse moves only to the element under the pointer, so a drag raises a transparent full-window capture layer
// (`ResizeCaptureLayer`, mounted once at the window root next to the other drag layers) that follows the pointer and ends on
// release. It is a plain element: an `<anchored>` layer would paint an opaque backing under its transparent content. The handle's
// line is `pointerEvents: 'none'` (GPUIX hit-tests a child before its parent, so a plain child over the handle swallows the press).
import { motion } from '@gpuix/react'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { load, save } from '../shell/persist.ts'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'

interface Drag {
  cursor: 'col-resize' | 'row-resize'
  move: (point: { x: number; y: number }) => void
  end: () => void
}
let drag: Drag | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

function begin(next: Drag) {
  drag?.end()
  drag = next
  emit()
}
function finish() {
  const done = drag
  drag = null
  done?.end()
  emit()
}

/** Mount once as the last child of the window root. Renders nothing until a drag starts. */
export function ResizeCaptureLayer() {
  const active = useSyncExternalStore(subscribe, () => drag)
  if (!active) return null
  return (
    <div
      testId="resize-capture"
      onMouseMove={(e) => {
        if (e.pressedButton !== 0) return finish()
        if (e.x !== undefined && e.y !== undefined) drag?.move({ x: e.x, y: e.y })
      }}
      onMouseUp={finish}
      onMouseDownOutside={finish}
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', cursor: active.cursor }}
    />
  )
}

export interface ResizeOptions {
  initial: number
  min: number
  max: number
  /** Which side of the pane the handle is on: a handle on its right edge grows the pane when dragged right ("left" pane). */
  side: 'left' | 'right'
  /** Key in the per-environment UI store (`shell/persist.ts`), like the desktop's `localStorage` key. */
  storageKey?: string
  /** Vertical panes resize by the pointer's y. */
  axis?: 'x' | 'y'
}

/** `useResize`: width state with the drag, keyboard and reset handlers for a `ResizeHandle`. */
export function useResize(options: ResizeOptions) {
  const { initial, min, max, side, storageKey, axis = 'x' } = options
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, Math.round(value))), [min, max])
  const [width, setWidthState] = useState(() => {
    const saved = storageKey ? Number(load<number>(storageKey, NaN)) : NaN
    return saved >= min && saved <= max ? saved : initial
  })
  const [dragging, setDragging] = useState(false)
  const persist = useCallback((value: number) => { if (storageKey) save(storageKey, value) }, [storageKey])
  const setWidth = useCallback((value: number) => { const next = clamp(value); setWidthState(next); persist(next); return next }, [clamp, persist])
  /** Start a drag from the pointer's current coordinates (the handle's `onMouseDown` payload). */
  const onPointerDown = useCallback(
    (e: { x?: number; y?: number; button?: number }) => {
      if (e.button !== undefined && e.button !== 0) return
      const start = (axis === 'x' ? e.x : e.y) ?? 0
      const startWidth = width
      let latest = startWidth
      setDragging(true)
      begin({
        cursor: axis === 'x' ? 'col-resize' : 'row-resize',
        move: (point) => {
          const delta = (axis === 'x' ? point.x : point.y) - start
          latest = clamp(side === 'left' ? startWidth + delta : startWidth - delta)
          setWidthState(latest)
        },
        end: () => { setDragging(false); persist(latest) },
      })
    },
    [axis, width, side, clamp, persist],
  )
  return { width, dragging, setWidth, onPointerDown, reset: () => setWidth(initial) }
}

/**
 * The handle. Place it inside a `position: 'relative'` parent; `edge` is the parent's edge it straddles
 * (`left`/`right` → a vertical seam, `top`/`bottom` → a horizontal one). `valueNow` is the first pane's share for splitters.
 */
export function ResizeHandle({
  edge,
  label,
  dragging = false,
  onPointerDown,
  onKeyDown,
  onReset,
  valueNow,
  testId,
}: {
  edge: 'left' | 'right' | 'top' | 'bottom'
  label: string
  dragging?: boolean
  onPointerDown: (e: { x?: number; y?: number; button?: number }) => void
  onKeyDown?: (e: { key?: string; modifiers?: { shift: boolean } }) => void
  onReset?: () => void
  valueNow?: number
  testId?: string
}) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const vertical = edge === 'left' || edge === 'right'
  // `hover:after:bg-sidebar-border`, `focus-visible:after:bg-[var(--color-border-focus)]`, `dragging && after:bg-sidebar-border`.
  const shown = hover || focus || dragging
  const color = focus && !hover && !dragging ? t.v('--color-border-focus') : t.border
  return (
    <div
      testId={testId}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={valueNow === undefined ? undefined : 25}
      aria-valuemax={valueNow === undefined ? undefined : 75}
      aria-valuenow={valueNow}
      tabIndex={onKeyDown ? 0 : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onMouseDown={(e) => {
        if ((e.clickCount ?? 1) >= 2) return onReset?.()
        onPointerDown(e)
      }}
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        cursor: vertical ? 'col-resize' : 'row-resize',
        ...(vertical ? { top: 0, bottom: 0, width: 16 } : { left: 0, right: 0, height: 16 }),
        ...(edge === 'left' ? { left: -8 } : edge === 'right' ? { right: -8 } : edge === 'top' ? { top: -8 } : { bottom: -8 }),
      }}
    >
      <motion.div
        initial={false}
        animate={{ opacity: shown ? 1 : 0 }}
        transition={{ duration: REDUCED_MOTION ? 0 : shown ? 0.12 : 0.2, ease: [0.23, 1, 0.32, 1] }}
        style={{ position: 'absolute', backgroundColor: color, pointerEvents: 'none', ...(vertical ? { left: 7, top: 0, bottom: 0, width: 2 } : { top: 7, left: 0, right: 0, height: 2 }) }}
      />
    </div>
  )
}
