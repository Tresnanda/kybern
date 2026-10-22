// `components/kit/alert-dialog.tsx` on GPUIX, plus the modal plumbing `Sheet.tsx` shares: a full-window scrim
// layer and a card layer (`<anchored>`, like `nav/overlay.tsx`'s `Dialog`) that tween in AND out, an Escape
// stack so the innermost overlay (a select inside a sheet) closes first, and focus return to the opener.
//
// Geometry (measured from the desktop gallery in WebKit, `scripts/kit9-overlays-probe.mjs`): a 512px card
// (`max-w-lg`, 16px window margin), radius 22 (`rounded-3xl`), 1px `--color-border-light`, `bg-popover`, the
// `0 16px 50px -12px` lift; header 16/16/8 with 6px gap, title 18/22.5 semibold, description 14/19.25 muted;
// footer 12/16 with 8px gaps, buttons right-aligned. Escape closes it; a backdrop click does NOT (Base UI
// AlertDialog). Motion: the scrim fades over 200 ms `--ease-out`, the card fades and scales from 0.98 over 200 ms
// `--ease-in-out` both ways (Base UI keeps the popup mounted through `data-ending-style`). Both are `paintTransform`s on
// the layer's content (paint-only: no layout or render per frame; the anchored surface itself stays transparent).
// Reduce Motion: opacity only, the same fade.
import { useGpuix, useWindowSize, type StyleDesc } from '@gpuix/react'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { muted } from '../composer/Menu.tsx'

import { N } from '../nav/glyphs.ts'
import { pointerNav } from '../nav/store.ts'
import { useSettingsModal } from '../settings/controls.tsx'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'


import { Button, type ButtonVariant as ControlVariant } from './Button.tsx'
import { SCALE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import type { BackdropFilter } from '../native/backdrop.ts'
import { frostBackdrop, frostFill, useGlass } from '../platform/glass.ts'
import { GlassEdge } from './GlassEdge.tsx'

// ─── Escape stack ─────────────────────────────────────────────────────────

// Native key events bubble from the focused layer through every React ancestor, so a select open inside a
// sheet would close both on one Escape. Each open overlay registers here; only the innermost one (the last
// registered) acts, and it marks the event consumed for the handlers further up the same dispatch.
const stack: number[] = []
let nextLayer = 1
let consumed = false

/** Register an open overlay; `owns()` says whether it is the innermost open one. */
export function useEscapeLayer(open: boolean) {
  const [id] = useState(() => nextLayer++)
  useLayoutEffect(() => {
    if (!open) return
    stack.push(id)
    return () => {
      const i = stack.lastIndexOf(id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [open, id])
  return {
    /** Handle Escape for this layer: true (and consumed) when it is the innermost open overlay. */
    claim: () => {
      if (consumed || stack[stack.length - 1] !== id) return false
      consumed = true
      queueMicrotask(() => { consumed = false })
      return true
    },
    /** Whether this layer is the innermost open overlay (an outside press inside a nested popup is not this layer's). */
    isTop: () => stack[stack.length - 1] === id,
  }
}

/** Whether any kit overlay (dialog, sheet, select, combobox popup) is open: hosts with their own Escape check this. */
export const kitOverlayOpen = () => stack.length > 0

/** Renders `children` with the window size. Mount it only while a layer is up: a closed dialog keeps no 4 Hz poll. */
export function WindowSized({ children }: { children: (size: { width: number; height: number }) => ReactNode }) {
  const size = useWindowSize({ intervalMs: 250 })
  return <>{children(size)}</>
}

// ─── Presence (enter and exit tweens) ─────────────────────────────────────

let generation = 3_000_000

/** Keeps an overlay mounted through its exit tween. `phase` drives the layer motion; `done` unmounts. */
export function usePresence(open: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(open)
  const [phase, setPhase] = useState<'enter' | 'exit'>('enter')
  const [gen, setGen] = useState(() => ++generation)
  const last = useRef(open)
  if (open !== last.current) {
    last.current = open
    if (open) { setMounted(true); setPhase('enter'); setGen(++generation) }
    else if (mounted) { setPhase('exit'); setGen(++generation) }
  }
  // The exit normally ends on the card's `onMotionComplete`; this only guarantees the unmount if a layer
  // never reports it (no visible motion is driven from here).
  useEffect(() => {
    if (phase !== 'exit' || !mounted) return
    const timer = setTimeout(() => setMounted(false), exitMs + 250)
    return () => clearTimeout(timer)
  }, [phase, mounted, exitMs, gen])
  const done = (event: { motionGeneration?: number }) => {
    if (phase === 'exit' && (event.motionGeneration === undefined || event.motionGeneration === gen)) setMounted(false)
  }
  return { mounted, phase, gen, done }
}

export type Ease = [number, number, number, number]
/** Tailwind `ease-out` / `ease-in-out` resolve to the kit's `--ease-out` / `--ease-in-out` (motion.css:22-24). */
export const EASE_OUT_CSS: Ease = [0.23, 1, 0.32, 1]
export const EASE_IN_OUT_CSS: Ease = [0.77, 0, 0.175, 1]
/** Tailwind's default `transition` timing function (no `ease-*` class). */
export const EASE_DEFAULT: Ease = [0.4, 0, 0.2, 1]

/**
 * One `<anchored>` layer that fades (and optionally slides and scales) in and out natively. The motion is a `paintTransform` on the
 * layer's content (a retained-subtree transform: no layout, render or island work per frame), and the anchored surface carries no
 * fill of its own (`backdrop={{ blur: 0 }}` drops GPUI's opaque backing), so the content's `style` paints the scrim colour or the
 * card, and a scrim fades at its true alpha. Entering starts from `offset`/`scale`/opacity 0; an exit tweens back to them, and an
 * interrupted one retargets from what is on screen.
 */
export function ModalLayer({
  phase,
  gen,
  onExited,
  duration,
  ease,
  offset,
  scale,
  position,
  anchor = 'topLeft',
  priority,
  radius,
  testId,
  focus,
  onKeyDown,
  onMouseDownOutside,
  backdrop,
  style,
  children,
}: {
  phase: 'enter' | 'exit'
  gen: number
  onExited?: (event: { motionGeneration?: number }) => void
  duration: number
  ease: Ease
  /** Where the layer slides from (and back to), in px; dropped under Reduce Motion. */
  offset?: { top?: number; left?: number }
  /** The scale the layer grows from (and shrinks back to), about its centre; dropped under Reduce Motion. */
  scale?: number
  position: { x: number; y: number }
  anchor?: 'topLeft' | 'leftCenter' | 'bottomLeft'
  priority: number
  radius?: number
  testId?: string
  focus?: boolean
  onKeyDown?: (e: { key?: string; modifiers?: { shift?: boolean } }) => void
  onMouseDownOutside?: () => void
  /** The scene blur under a frosted card (whole-window glass, `frostBackdrop`); it moves with the card's transform. */
  backdrop?: BackdropFilter
  style?: StyleDesc
  children?: ReactNode
}) {
  const away = { opacity: 0, translateX: REDUCED_MOTION ? 0 : (offset?.left ?? 0), translateY: REDUCED_MOTION ? 0 : (offset?.top ?? 0), scale: REDUCED_MOTION ? 1 : (scale ?? 1) }
  const here = { opacity: 1, translateX: 0, translateY: 0, scale: 1 }
  // `initial` belongs to the mount: re-opening during an exit retargets from what is on screen instead of restarting.
  const mounted = useRef(gen).current
  const paintTransform = PATCHED_NATIVE
    ? { initial: phase === 'enter' && gen === mounted ? away : (false as const), animate: phase === 'enter' ? here : away, transition: { duration, ease }, generation: gen }
    : undefined
  return (
    <anchored
      backdrop={PATCHED_NATIVE ? { blur: 0 } : undefined}
      {...(PATCHED_NATIVE ? {} : { motion: { generation: gen, isExit: false, initial: phase === 'enter' ? { opacity: 0 } : { opacity: 1 }, animate: { opacity: phase === 'enter' ? 1 : 0 }, transition: { duration, ease } } } as object)}
      onMotionComplete={(event) => { if (!PATCHED_NATIVE) onExited?.(event as { motionGeneration?: number }) }}
      position={position}
      anchor={anchor}
      fit="snap"
      snapMargin={0}
      deferred
      priority={priority}
      style={{ ...(radius !== undefined ? { borderRadius: radius } : {}) }}
    >
      <div
        testId={testId}
        tabIndex={focus ? 0 : undefined}
        autoFocus={focus}
        onKeyDown={onKeyDown}
        onMouseDown={pointerNav}
        onMouseDownOutside={onMouseDownOutside}
        {...(backdrop ? { backdrop } : {})}
        {...(paintTransform ? { paintTransform, onMotionComplete: (event: { motionGeneration?: number }) => { if (phase === 'exit' && event.motionGeneration === gen) onExited?.(event) } } : {})}
        style={{ ...(phase === 'exit' ? { pointerEvents: 'none' } : {}), ...style }}
      >
        {children}
      </div>
    </anchored>
  )
}

/** Remember the focused element when an overlay opens and give focus back to it after the overlay closes. */
export function useReturnFocus(open: boolean) {
  const { renderer } = useGpuix()
  const opener = useRef<number | null | undefined>(null)
  useLayoutEffect(() => {
    if (open) { opener.current = renderer?.getFocusedElementId?.(); return }
    const id = opener.current
    if (id != null) queueMicrotask(() => { try { renderer?.focusElement?.(id) } catch { /* Element gone. */ } })
  }, [open, renderer])
}

// ─── Buttons ──────────────────────────────────────────────────────────────

/** The desktop `Button` variant names `AlertDialogClose` and `SheetClose` callers still pass; `controlVariant` maps them onto `kit/Button`. */
export type ButtonVariant = 'default' | 'outline' | 'destructive' | 'destructive-outline' | 'ghost' | 'secondary' | 'subtle'

// ─── AlertDialog ──────────────────────────────────────────────────────────

const DURATION = 0.2
const AlertContext = createContext<{ close: () => void } | null>(null)

/** `AlertDialog` + `AlertDialogPopup`: controlled (`open`/`onOpenChange`) or uncontrolled (`defaultOpen`). */
export function AlertDialog({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  width = 512,
  children,
  testId,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** `max-w-lg`; a `className="max-w-md"` caller passes 448. */
  width?: number
  children: ReactNode
  testId?: string
}) {
  const t = useTheme()
  const g = useGlass()
  const [own, setOwn] = useState(defaultOpen)
  const open = openProp ?? own
  const setOpen = (next: boolean) => { if (openProp === undefined) setOwn(next); onOpenChange?.(next) }
  const presence = usePresence(open, DURATION * 1000)
  const escape = useEscapeLayer(open)
  useSettingsModal(open)
  useReturnFocus(open)
  if (!presence.mounted) return null
  return <WindowSized>{(size) => {
    const cardWidth = Math.min(width, size.width - 32)
    return (
      <AlertContext.Provider value={{ close: () => setOpen(false) }}>
        <ModalLayer
          phase={presence.phase}
          gen={presence.gen}
          duration={DURATION}
          ease={EASE_OUT_CSS}
          position={{ x: 0, y: 0 }}
          priority={5}
          testId={testId ? `${testId}-backdrop` : undefined}
          style={{ width: size.width, height: size.height, backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        />
        <ModalLayer
          phase={presence.phase}
          gen={presence.gen}
          onExited={presence.done}
          duration={DURATION}
          ease={EASE_IN_OUT_CSS}
          scale={SCALE.small}
          position={{ x: Math.round((size.width - cardWidth) / 2), y: size.height / 2 }}
          anchor="leftCenter"
          priority={6}
          radius={22}
          backdrop={frostBackdrop(g, 'menus', 22)}
          testId={testId}
          focus
          onKeyDown={(e) => { if (e.key === 'escape' && escape.claim()) setOpen(false) }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: cardWidth,
            maxHeight: size.height - 32,
            borderRadius: 22,
            borderWidth: 1,
            position: 'relative',
            borderColor: g.on ? g.frostRim : t.borderLight,
            // Whole-window glass: the menu frost, and no shadow under a fill that is not opaque.
            backgroundColor: frostFill(g, 'menus', t.v('--popover'), 'frostMenu'),
            ...(g.on ? {} : { boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 50, spreadRadius: -12, color: t.variant === 'dark' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.34)' } }),
            overflow: 'hidden',
          }}
        >
          <GlassEdge radius={22} color={g.frostHighlight} />
          {children}
        </ModalLayer>
      </AlertContext.Provider>
    )
  }}</WindowSized>
}

/** `AlertDialogHeader`: 16px sides and top, 8px bottom, 6px between title and description. */
export function AlertDialogHeader({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 8 }}>{children}</div>
}

/** `AlertDialogTitle`: `font-heading font-semibold text-lg leading-tight`. */
export function AlertDialogTitle({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={t.text} size={18} lineHeight={22.5} weight={600}>{children}</Label>
}

/** `AlertDialogDescription`: `text-muted-foreground text-sm leading-snug`. */
export function AlertDialogDescription({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={muted(t, 1)} size={14} lineHeight={19.25}>{children}</Label>
}

/** `AlertDialogFooter`: buttons right-aligned, 8px apart; `default` 12px vertical padding, `bare` 12/16. */
export function AlertDialogFooter({ children, variant = 'default' }: { children: ReactNode; variant?: 'default' | 'bare' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: variant === 'bare' ? 16 : 12 }}>
      {children}
    </div>
  )
}

/** `AlertDialogClose render={<Button variant=… />}`: a footer button that runs `onClick`, then closes. Its slot is
 *  `alert-dialog-close`, so unlike a plain `Button` it does not squash on press. */
export function AlertDialogClose({ children, variant = 'secondary', onClick, disabled, testId }: { children: string; variant?: ButtonVariant | ControlVariant; onClick?: () => void; disabled?: boolean; testId?: string }) {
  const ctx = useContext(AlertContext)
  const { variant: kind, danger } = controlVariant(variant)
  return <Button size="lg" variant={kind} danger={danger} disabled={disabled} testId={testId} onClick={() => { onClick?.(); ctx?.close() }}>{children}</Button>
}

/** The control system's variant for a legacy `KitButton` one (`outline`/`subtle`/`secondary` → secondary, `default` → primary). */
export function controlVariant(variant: ButtonVariant | ControlVariant): { variant: ControlVariant; danger: boolean } {
  switch (variant) {
    case 'default': case 'primary': return { variant: 'primary', danger: false }
    case 'destructive': return { variant: 'destructive', danger: false }
    case 'destructive-outline': return { variant: 'secondary', danger: true }
    case 'ghost': return { variant: 'ghost', danger: false }
    default: return { variant: 'secondary', danger: false }
  }
}

/** The ghost close glyph (`XIcon`) used by sheets and dialogs. */
export const CLOSE_GLYPH = N.x

/** `text-muted-foreground` helpers re-exported for kit callers. */
export { ink, muted }
