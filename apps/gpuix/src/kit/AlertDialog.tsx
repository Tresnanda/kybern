// `components/kit/alert-dialog.tsx` on GPUIX, plus the modal plumbing `Sheet.tsx` shares: a full-window scrim
// layer and a card layer (`<anchored>`, like `nav/overlay.tsx`'s `Dialog`) that tween in AND out, an Escape
// stack so the innermost overlay (a select inside a sheet) closes first, and focus return to the opener.
//
// Geometry (measured from the desktop gallery in WebKit, `scripts/kit9-overlays-probe.mjs`): a 512px card
// (`max-w-lg`, 16px window margin), radius 22 (`rounded-3xl`), 1px `--color-border-light`, `bg-popover`, the
// `0 16px 50px -12px` lift; header 16/16/8 with 6px gap, title 18/22.5 semibold, description 14/19.25 muted;
// footer 12/16 with 8px gaps, buttons right-aligned. Escape closes it; a backdrop click does NOT (Base UI
// AlertDialog). Motion: the scrim fades over 200 ms `--ease-out`, the card fades over 200 ms `--ease-in-out`
// both ways (Base UI keeps the popup mounted through `data-ending-style`). The desktop card also scales from
// 0.98, which GPUIX cannot do to a subtree: the opacity, duration and curve are kept and the scale is dropped.
// Reduce Motion: the desktop has no reduced variant here; GPUIX keeps the fades (kit rule: fades stay).
import { useGpuix, useWindowSize, type StyleDesc } from '@gpuix/react'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { muted } from '../composer/Menu.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { pointerNav } from '../nav/store.ts'
import { useSettingsModal } from '../settings/controls.tsx'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { pressTransform } from '../motion/press.ts'

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
 * One `<anchored>` layer that fades (and optionally slides) in and out natively. The tween runs on the anchored
 * surface itself, which carries its own fill (`backing`), so GPUI's dark backing never shows through.
 */
export function ModalLayer({
  phase,
  gen,
  onExited,
  duration,
  ease,
  offset,
  position,
  anchor = 'topLeft',
  priority,
  backing,
  radius,
  testId,
  focus,
  onKeyDown,
  onMouseDownOutside,
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
  position: { x: number; y: number }
  anchor?: 'topLeft' | 'leftCenter' | 'bottomLeft'
  priority: number
  backing?: string
  radius?: number
  testId?: string
  focus?: boolean
  onKeyDown?: (e: { key?: string; modifiers?: { shift?: boolean } }) => void
  onMouseDownOutside?: () => void
  style?: StyleDesc
  children?: ReactNode
}) {
  const away = { opacity: 0, top: REDUCED_MOTION ? 0 : (offset?.top ?? 0), left: REDUCED_MOTION ? 0 : (offset?.left ?? 0) }
  const here = { opacity: 1, top: 0, left: 0 }
  const motion = { generation: gen, isExit: false, initial: phase === 'enter' ? away : here, animate: phase === 'enter' ? here : away, transition: { duration, ease } }
  return (
    <anchored
      {...({ motion } as object)}
      onMotionComplete={(event) => onExited?.(event as { motionGeneration?: number })}
      position={position}
      anchor={anchor}
      fit="snap"
      snapMargin={0}
      deferred
      priority={priority}
      style={{ ...(backing ? { backgroundColor: backing } : {}), ...(radius !== undefined ? { borderRadius: radius } : {}) }}
    >
      <div
        testId={testId}
        tabIndex={focus ? 0 : undefined}
        autoFocus={focus}
        onKeyDown={onKeyDown}
        onMouseDown={pointerNav}
        onMouseDownOutside={onMouseDownOutside}
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

// TODO(kit): stand-in for the desktop `Button` (`components/kit/button.tsx`) until the kit has one; only the
// variants overlays and their galleries use. Size `default`: 32 high, 11px side padding inside a 1px border,
// radius 10, 14/21 medium. `icon`: 32 square. Hover fills are instant; the desktop's 0.97 press scale has no
// GPUIX subtree equivalent and is dropped.
export type ButtonVariant = 'default' | 'outline' | 'destructive' | 'destructive-outline' | 'ghost' | 'secondary' | 'subtle'

function buttonColors(t: Theme, variant: ButtonVariant) {
  const fg = t.v('--foreground')
  switch (variant) {
    case 'default': return { bg: t.v('--primary'), hover: withAlpha(t.v('--primary'), 0.9), border: 'rgba(0, 0, 0, 0)', text: t.v('--primary-foreground') }
    case 'destructive': return { bg: t.v('--destructive'), hover: withAlpha(t.v('--destructive'), 0.9), border: t.v('--destructive'), text: '#ffffff' }
    case 'destructive-outline': return { bg: t.v('--color-background-elevated-primary-opaque'), hover: withAlpha(t.v('--destructive'), 0.04), border: t.border, text: t.v('--destructive') }
    case 'secondary': return { bg: t.v('--secondary'), hover: withAlpha(t.v('--secondary'), 0.9), border: 'rgba(0, 0, 0, 0)', text: t.v('--secondary-foreground') }
    case 'subtle': return { bg: t.buttonSecondary, hover: t.buttonSecondaryHover, border: 'rgba(0, 0, 0, 0)', text: fg }
    case 'ghost': return { bg: 'rgba(0, 0, 0, 0)', hover: t.buttonSecondaryHover, border: 'rgba(0, 0, 0, 0)', text: t.textSecondary, hoverText: fg }
    default: return { bg: 'rgba(0, 0, 0, 0)', hover: t.v('--color-background-elevated-secondary'), border: t.border, text: fg }
  }
}

/** `#rrggbb`/`rgb()` at an alpha (Tailwind's `bg-primary/90`). */
function withAlpha(color: string, alpha: number) {
  const hex = color.match(/^#([0-9a-f]{6})$/i)
  if (hex) { const n = parseInt(hex[1]!, 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})` }
  const rgb = color.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) { const [r, g, b, a = '1'] = rgb[1]!.split(/[\s,/]+/).filter(Boolean); return `rgba(${r}, ${g}, ${b}, ${Number(a) * alpha})` }
  return color
}

export function KitButton({
  children,
  variant = 'default',
  size = 'default',
  icon,
  label,
  onClick,
  disabled = false,
  testId,
  press = true,
}: {
  children?: string
  /** `[data-slot="button"]` press (0.97). False where Base UI renders it as another part (`alert-dialog-close`), which does not scale. */
  press?: boolean
  variant?: ButtonVariant
  /** Measured from the desktop in WebKit (1px border included). `sm`: 28 high, 9px side padding, 14/21 text. `chip`: auto height, 8/2 padding, 13/19.5 text (`--app-font-size-ui-sm`). */
  size?: 'default' | 'icon' | 'sm' | 'chip'
  /** Glyph source for `size="icon"` (16px at 80%). */
  icon?: string
  /** Accessible name (icon buttons). */
  label?: string
  onClick?: () => void
  disabled?: boolean
  testId?: string
}) {
  const t = useTheme()
  const c = buttonColors(t, variant)
  const [hover, setHover] = useState(false)
  const text = hover && c.hoverText ? c.hoverText : c.text
  return (
    <div
      testId={testId}
      role="button"
      aria-label={label ?? children}
      tabIndex={disabled ? -1 : 0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => { if (!disabled) onClick?.() }}
      onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick?.() }}
      paintTransform={pressTransform(press && !disabled)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: size === 'chip' ? 4 : size === 'sm' ? 6 : 8,
        flexShrink: 0,
        ...(size === 'chip' ? { paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2 } : { height: size === 'sm' ? 28 : 32 }),
        ...(size === 'icon' ? { width: 32 } : size === 'sm' ? { paddingLeft: 9, paddingRight: 9 } : size === 'chip' ? {} : { paddingLeft: 11, paddingRight: 11 }),
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: hover && !disabled ? c.hover : c.bg,
        opacity: disabled ? 0.64 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {size === 'icon' && icon ? (
        <Icon source={icon} size={16} color={text} style={{ opacity: 0.8, pointerEvents: 'none' }} />
      ) : (
        <Label color={text} size={size === 'chip' ? 13 : 14} lineHeight={size === 'chip' ? 19.5 : 21} weight={500} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          {children}
        </Label>
      )}
    </div>
  )
}

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
          backing="rgba(0, 0, 0, 0.6)"
          testId={testId ? `${testId}-backdrop` : undefined}
          style={{ width: size.width, height: size.height }}
        />
        <ModalLayer
          phase={presence.phase}
          gen={presence.gen}
          onExited={presence.done}
          duration={DURATION}
          ease={EASE_IN_OUT_CSS}
          position={{ x: Math.round((size.width - cardWidth) / 2), y: size.height / 2 }}
          anchor="leftCenter"
          priority={6}
          radius={22}
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
            borderColor: t.borderLight,
            backgroundColor: t.v('--popover'),
            boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 50, spreadRadius: -12, color: t.variant === 'dark' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.34)' },
            overflow: 'hidden',
          }}
        >
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
export function AlertDialogClose({ children, variant = 'outline', onClick, disabled, testId }: { children: string; variant?: ButtonVariant; onClick?: () => void; disabled?: boolean; testId?: string }) {
  const ctx = useContext(AlertContext)
  return <KitButton press={false} variant={variant} disabled={disabled} testId={testId} onClick={() => { onClick?.(); ctx?.close() }}>{children}</KitButton>
}

/** The ghost close glyph (`XIcon`) used by sheets and dialogs. */
export const CLOSE_GLYPH = N.x

/** `text-muted-foreground` helpers re-exported for kit callers. */
export { ink, muted }
