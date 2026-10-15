import { onEnvironmentChange } from './environment.ts'
// Toasts (issue #108 §23): the desktop's sonner `Toaster` at the bottom right
// (`components/ui/sonner.tsx`, `views/AppUpdate.tsx`), on GPUIX.
//
//   toast('Saved to “Notes”', { action: { label: 'Open', onClick } })
//   toast.error('Unable to load thread', { description })
//   toast.dismiss(id)
//
// Geometry follows sonner: 356px wide, 16px padding, 14px between toasts, 24px
// from the window's corner, three visible (the newest), the popover surface with
// its 1px border, 13px text, a 16px icon, and an ink action pill (24px, 4px
// radius, 12px/500). A toast times out after 4 s unless `duration` says
// otherwise (`Infinity` stays until dismissed: approvals). The timer stops while
// the pointer is over the stack and while the window is hidden, and resumes with
// the time that was left. No timer exists while no toast does.
//
// Motion: a toast rises 12px and fades in over 300 ms; it leaves in 160 ms, so
// exits are faster than entrances. Both retarget if a toast is dismissed
// mid-entrance. Under Reduce Motion a toast only fades, 120 ms.
import {
  AlertCircleIcon,
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from '@hugeicons/core-free-icons'
import { useGpuixRequired, useWindowSize, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { glyph, Icon } from '../icons.tsx'
import { onWindowVisibility, isWindowVisible } from '../native/visibility.ts'
import { EASE } from '../motion/kit.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'

export type ToastKind = 'default' | 'success' | 'info' | 'warning' | 'error'

export interface ToastOptions {
  /** Updates the toast with this id in place instead of stacking another. */
  id?: string
  description?: string
  action?: { label: string; onClick: () => void }
  /** Milliseconds before it leaves; `Infinity` keeps it until dismissed. Default 4000. */
  duration?: number
}

interface Item {
  id: string
  kind: ToastKind
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
  duration: number
  /** The card's height in px: measured once painted, estimated before. */
  height: number
  leaving: boolean
  /** Time left on the timer while it is paused or not yet started. */
  remaining: number
  /** When the running timer started, or null while it is not running. */
  startedAt: number | null
  timer?: ReturnType<typeof setTimeout>
}

const WIDTH = 356
const GAP = 14
const OFFSET = 24
const VISIBLE = 3
/** A one-line toast: 16px padding either side, a 20px title, the border. */
const ESTIMATE = 54
const DEFAULT_DURATION = 4000
const ENTER = 0.3
const EXIT = 0.16

let items: Item[] = []
let snapshot: readonly Item[] = items
let hovered = false
let hidden = false
let nextId = 1
const listeners = new Set<() => void>()

function commit() {
  snapshot = [...items]
  reconcile()
  listeners.forEach((l) => l())
}

/** Start or stop each toast's timer to match what is on screen right now. */
function reconcile() {
  const shown = new Set(items.filter((i) => !i.leaving).slice(-VISIBLE))
  const paused = hovered || hidden
  for (const item of items) {
    const run = !paused && shown.has(item) && Number.isFinite(item.duration) && !item.leaving
    if (run && item.startedAt === null) {
      item.startedAt = Date.now()
      item.timer = setTimeout(() => dismiss(item.id), Math.max(0, item.remaining))
    } else if (!run && item.startedAt !== null) {
      clearTimeout(item.timer)
      item.remaining -= Date.now() - item.startedAt
      item.startedAt = null
    }
  }
}

function remove(id: string) {
  items = items.filter((i) => i.id !== id)
  if (items.length === 0) hovered = false
  commit()
}

/** Dismiss one toast, or all of them with no id. It leaves, then is removed. */
function dismiss(id?: string) {
  for (const item of items) {
    if (item.leaving || (id !== undefined && item.id !== id)) continue
    clearTimeout(item.timer)
    item.startedAt = null
    item.leaving = true
    setTimeout(() => remove(item.id), (REDUCED_MOTION ? 0.12 : EXIT) * 1000 + 40)
  }
  commit()
}

/** Record a toast's measured height so the stack above it sits right. */
function setHeight(id: string, height: number) {
  const item = items.find((i) => i.id === id)
  if (!item) return
  item.height = height
  commit()
}

function show(kind: ToastKind, title: string, options: ToastOptions = {}): string {
  const id = options.id ?? `toast-${nextId++}`
  const duration = options.duration ?? DEFAULT_DURATION
  const existing = items.find((i) => i.id === id)
  const fields = {
    kind,
    title,
    description: options.description,
    action: options.action,
    duration,
    remaining: duration,
  }
  if (existing && !existing.leaving) {
    // An update in place: new text, and the timer starts over.
    clearTimeout(existing.timer)
    Object.assign(existing, fields, { startedAt: null })
  } else {
    if (existing) {
      clearTimeout(existing.timer)
      items = items.filter((i) => i !== existing)
    }
    items.push({ id, leaving: false, startedAt: null, height: ESTIMATE, ...fields })
  }
  commit()
  return id
}

export const toast = Object.assign((title: string, options?: ToastOptions) => show('default', title, options), {
  success: (title: string, options?: ToastOptions) => show('success', title, options),
  info: (title: string, options?: ToastOptions) => show('info', title, options),
  warning: (title: string, options?: ToastOptions) => show('warning', title, options),
  error: (title: string, options?: ToastOptions) => show('error', title, options),
  dismiss,
})

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

const ICONS: Record<ToastKind, string | null> = {
  default: null,
  success: glyph(CheckmarkCircle02Icon),
  info: glyph(InformationCircleIcon),
  warning: glyph(Alert02Icon),
  error: glyph(AlertCircleIcon),
}
const CLOSE = glyph(Cancel01Icon)

/** Mount once, near the end of the window's tree. Renders nothing, and runs nothing, while no toast shows. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => snapshot)
  return list.length > 0 ? <ToastStack list={list} /> : null
}

function ToastStack({ list }: { list: readonly Item[] }) {
  const size = useWindowSize({ intervalMs: 250 })
  useEffect(() => {
    // Timers pause while the window is hidden (covered, minimized, another Space).
    hidden = !isWindowVisible()
    reconcile()
    const stop = onWindowVisibility((visible) => {
      hidden = !visible
      reconcile()
    })
    return () => {
      stop()
      hidden = false
      hovered = false
    }
  }, [])
  // The newest three stay; a toast that is leaving still renders so its exit plays.
  const newest = new Set(list.filter((i) => !i.leaving).slice(-VISIBLE))
  const visible = list.filter((i) => i.leaving || newest.has(i))
  // Newest at the bottom; each older toast sits above the ones after it.
  let lift = 0
  const placed = [...visible].reverse().map((item) => {
    const entry = { item, lift }
    if (!item.leaving) lift += item.height + GAP
    return entry
  })
  return (
    <>
      {placed.map(({ item, lift: above }) => (
        <ToastLayer key={item.id} item={item} x={size.width - OFFSET} y={size.height - OFFSET - above} lift={above} />
      ))}
    </>
  )
}

const hoverStack = (on: boolean) => () => {
  hovered = on
  reconcile()
}

/**
 * One toast on its own `<anchored>` layer. Each layer is exactly its card, so the
 * opaque backing GPUIX paints under an anchored surface is hidden by the card
 * (a shared layer showed it in the gaps and while rows faded). The motion runs
 * on the layer itself: it rises 12px and fades in over 300 ms, glides when a
 * newer toast pushes it up, and leaves in 160 ms, faster than it came. Reduce
 * Motion keeps the 120 ms fades and drops the movement.
 */
function ToastLayer({ item, x, y, lift }: { item: Item; x: number; y: number; lift: number }) {
  const renderer = useGpuixRequired()
  const card = useRef<PublicInstance>(null)
  const move = REDUCED_MOTION ? 0 : 12
  // What the layer is doing: arriving, gliding after the stack moved, or leaving.
  const [motion, setMotion] = useState<Motion>(() => ({ generation: ++generation, initial: { opacity: 0, top: move }, animate: { opacity: 1, top: 0 }, ease: EASE.smoothOut, duration: REDUCED_MOTION ? 0.12 : ENTER }))
  const last = useRef({ lift, leaving: item.leaving })
  if (last.current.leaving !== item.leaving && item.leaving) {
    last.current = { lift, leaving: true }
    setMotion({ generation: ++generation, initial: { opacity: 1, top: 0 }, animate: { opacity: 0, top: REDUCED_MOTION ? 0 : 4 }, ease: EASE.out, duration: REDUCED_MOTION ? 0.12 : EXIT })
  } else if (last.current.lift !== lift && !item.leaving) {
    // A toast arrived or left below: start where this one was and glide up (or down) to its place.
    const delta = REDUCED_MOTION ? 0 : lift - last.current.lift
    last.current = { lift, leaving: false }
    setMotion({ generation: ++generation, initial: { opacity: 1, top: delta }, animate: { opacity: 1, top: 0 }, ease: EASE.smoothOut, duration: DURATION_GLIDE })
  }
  // Measure once painted: the stack needs each card's real height (text wraps).
  useEffect(() => {
    const timer = setTimeout(() => {
      const id = card.current?.id
      const bounds = id != null ? renderer.getElementBounds?.(id) : null
      if (bounds && Math.abs(bounds.height - item.height) > 0.5) setHeight(item.id, bounds.height)
    }, 32)
    return () => clearTimeout(timer)
  }, [renderer, item.id, item.title, item.description, item.height])
  return (
    <anchored
      {...({ motion: { generation: motion.generation, isExit: item.leaving, initial: motion.initial, animate: motion.animate, transition: { duration: motion.duration, ease: [...motion.ease] } } } as object)}
      style={{ borderRadius: 10 }}
      position={{ x, y }}
      anchor="bottomRight"
      fit="snap"
      snapMargin={8}
      deferred
      priority={6}
      occlude
    >
      <div ref={card} onMouseEnter={hoverStack(true)} onMouseLeave={hoverStack(false)}>
        <ToastCard item={item} />
      </div>
    </anchored>
  )
}

let generation = 2_000_000
interface Motion {
  generation: number
  initial: { opacity: number; top: number }
  animate: { opacity: number; top: number }
  ease: readonly number[]
  duration: number
}
const DURATION_GLIDE = 0.25

function ToastCard({ item }: { item: Item }) {
  const t = useTheme()
  const [hover, setHover] = useState(false)
  const icon = ICONS[item.kind]
  return (
    <div
      testId={`toast-${item.kind}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: WIDTH,
        padding: 16,
        position: 'relative',
        borderRadius: 10,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.popover,
        boxShadow: { offsetX: 0, offsetY: 4, blurRadius: 12, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.1)' },
      }}
    >
      {icon && <Icon source={icon} size={16} color={t.text} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        <Label color={t.text} size={13} weight={500} lineHeight={20}>
          {item.title}
        </Label>
        {item.description && (
          <Label color={t.textSecondary} size={13} lineHeight={18}>
            {item.description}
          </Label>
        )}
      </div>
      {item.action && (
        <div
          testId="toast-action"
          role="button"
          onClick={() => {
            item.action!.onClick()
            dismiss(item.id)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 24,
            paddingLeft: 8,
            paddingRight: 8,
            marginLeft: 8,
            borderRadius: 4,
            flexShrink: 0,
            cursor: 'pointer',
            backgroundColor: t.buttonPrimary,
            active: { opacity: 0.8 },
          }}
        >
          <Label color={t.buttonPrimaryText} size={12} weight={500} lineHeight={16}>
            {item.action.label}
          </Label>
        </div>
      )}
      {/* No swipe-away on a desktop window: a hover close keeps a persistent toast dismissable. */}
      {hover && (
        <div
          testId="toast-close"
          role="button"
          aria-label="Dismiss"
          onClick={() => dismiss(item.id)}
          style={{
            position: 'absolute',
            top: -6,
            left: -6,
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.popover,
            cursor: 'pointer',
          }}
        >
          <Icon source={CLOSE} size={10} color={t.textSecondary} />
        </div>
      )}
    </div>
  )
}

onEnvironmentChange(() => { for (const item of items) clearTimeout(item.timer); items = []; hovered = false; commit() })
