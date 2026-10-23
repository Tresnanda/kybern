import { GlassEdge } from '../kit/GlassEdge.tsx'
import { frostBackdrop, frostFill, useGlass } from '../platform/glass.ts'
// The composer's picker menus (`ComposerPickerMenuPopup` + `components/kit/menu.tsx`,
// "normal" picker size in `kit.css:2960`): a 0.65rem-radius opaque popover with a
// 1px border and the composer's soft shadow, 4px body padding, 26px option rows
// at 8px radius, 12px group labels and 1px separators.
//
// It sits on an `<anchored>` overlay (`PopupLayer`, GPUIX's `FloatingLayer` plus
// motion), so it paints above the transcript. It opens like the desktop's
// `menu.tsx` popup: a 250 ms smooth-out scale from 97% with a 2px blur that
// clears, about the trigger's corner (`popupTransform` in `motion/kit.tsx`,
// paint-only), and closes instantly unless the owner passes `leaving` (then it
// scales to 99% and fades over 150 ms, and `onLeft` fires).
// Keyboard: ↑/↓ move the highlight, Enter/Space pick, Escape closes and returns
// focus to the trigger. Nothing is highlighted until the pointer or a key moves,
// like Base UI menus opened with the pointer.
import { useGpuix, type AnchoredProps, type Props, type PublicInstance, type StyleDesc } from '@gpuix/react'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Icon } from '../icons.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { BLUR, DURATION, EASE, POPUP, popupOrigin, popupTransform, SCALE } from '../motion/kit.tsx'
import { EXIT, exitsInstantly, nextPresenceGeneration, presenceTransform } from '../motion/Presence.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import type { PaintTransformProps } from '@gpuix/native/host'
import { G } from './glyphs.ts'
import { WebLayer, useWebOcclusion } from '../native/web-occlusion.ts'

/** `rounded-[0.65rem]` panels, `rounded-[0.5rem]` rows. */
export const PICKER_RADIUS = 10.4
export const OPTION_RADIUS = 8

/** `COMPOSER_SURFACE_SHADOW_CLASS_NAME`. */
export function surfaceShadow(t: Theme) {
  return t.variant === 'dark'
    ? { offsetX: 0, offsetY: 6, blurRadius: 24, spreadRadius: -10, color: 'rgba(0, 0, 0, 0.30)' }
    : { offsetX: 0, offsetY: 4, blurRadius: 18, spreadRadius: -6, color: 'rgba(13, 13, 13, 0.07)' }
}

/** The opaque picker shell: `bg-popover`, `border-border`, picker radius and shadow. */
export function popoverStyle(t: Theme): StyleDesc {
  return {
    backgroundColor: t.popover,
    borderWidth: 1,
    borderColor: t.border,
    borderRadius: PICKER_RADIUS,
    boxShadow: surfaceShadow(t),
  }
}

/** Where the popup grows from when `anchor` names the corner of the popup that sits at `position` (default top-left). */
const LAYOUT_POPUPS = process.env.KYBERN_POPUP_MOTION === 'layout'

const ANCHOR_ORIGIN: Record<NonNullable<AnchoredProps['anchor']>, [number, number]> = {
  topLeft: [0, 0], topCenter: [0.5, 0], topRight: [1, 0], rightCenter: [1, 0.5],
  bottomRight: [1, 1], bottomCenter: [0.5, 1], bottomLeft: [0, 1], leftCenter: [0, 0.5],
}

/**
 * The other two popup arrivals, for the dialog (`dialog.tsx:27,55`): `dialog` is the card (opacity 0, scale `--scale-large` 0.96 and a
 * 2 px blur, 250 ms smooth-out, about its centre; the exit is `EXIT.dialog`), `scrim` the black backdrop (opacity only, 250 ms in,
 * `EXIT.backdrop` out). Reduce Motion fades 150 ms. `undefined` with the stock addon.
 */
function appearTransform(appear: 'dialog' | 'scrim', origin: [number, number]): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  const ease: [number, number, number, number] = [...EASE.smoothOut]
  if (REDUCED_MOTION) return { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease }, origin }
  const initial = appear === 'dialog' ? { opacity: 0, scale: SCALE.large, blur: BLUR.small } : { opacity: 0 }
  return { initial, animate: appear === 'dialog' ? { opacity: 1, scale: 1, blur: 0 } : { opacity: 1 }, transition: { duration: DURATION.fast, ease }, origin }
}

/**
 * `FloatingLayer` (`@gpuix/react/floating`) with the desktop's popup open
 * (`data-starting-style` in `components/kit/menu.tsx` and `popover.tsx`). Every
 * popup that is not `still` or a `fade` layer materializes: it scales up from
 * 97% with a 2px blur and fades in over 250 ms (150 ms and 98% for `kind:
 * 'tooltip'`) about the trigger's corner, painted natively (`paintTransform`,
 * no layout or render per frame). `side` is where the popup sits relative to
 * its trigger. `fade` layers (the dialog's scrim and card) keep the layout
 * tween of an `<anchored motion>`.
 *
 * Also used by the thread panel, rail and title bar (`nav/overlay.tsx`), which
 * add: `kind` (tooltip timing), `position`/`anchor` (context menus at the
 * pointer, centred dialogs), `still` (opened by a shortcut or carried over:
 * no motion), `fade` (a plain fade to an opacity, optionally rising, for
 * the dialog backdrop and card), and `leaving`/`onLeft` (an exit; see below).
 */
export const PopupLayer = forwardRef<PublicInstance, Omit<Props, 'ref'> & {
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  collisionPadding?: number
  kind?: keyof typeof POPUP
  alignOffset?: number
  position?: { x: number; y: number }
  anchor?: AnchoredProps['anchor']
  fit?: 'snap' | 'switch'
  priority?: number
  occlude?: boolean
  material?: 'popup' | 'none'
  still?: boolean
  fade?: { opacity?: number; rise?: number }
  /** Fill of the `<anchored>` surface itself, replacing GPUI's opaque dark backing (a translucent scrim). */
  backing?: string
  /**
   * `data-starting-style:scale-[var(--scale-medium)] opacity-0` from `--transform-origin` (`popover.tsx`): the
   * popup scales up from 97% and fades in over 250 ms (`--ease-smooth-out`) about `origin` (fractions of its box,
   * the trigger's side). Paint-only (`paintTransform`), so no render or layout runs per frame. The anchored
   * layer's own motion is off and its opaque backing made transparent, so the whole popup arrives as one
   * material. Reduce Motion fades in 150 ms with no scale; the stock addon just shows the popup. Every popup does this by
   * default now, with `origin` derived from `side`/`align` (or `anchor` for a positioned layer); pass `materialize` only to
   * choose the origin yourself.
   */
  materialize?: { origin: [number, number] }
  /**
   * The owner is closing this popup but keeps it mounted until `onLeft`: it scales to 99% and fades out over 150 ms (80 ms
   * and 98% for a tooltip), non-interactive, retargeting back to rest if `leaving` turns false again. Reduce Motion fades 100 ms.
   * Keyboard closes should unmount at once instead (do not set `leaving`). `onLeft` fires when the exit completes, or right
   * away when the popup cannot animate (`still`, stock addon, hidden window).
   */
  leaving?: boolean
  onLeft?: () => void
  /**
   * `'dialog'` / `'scrim'`: the arrival and exit of a modal's card and its backdrop (`appearTransform`) instead of the menu's
   * 0.97 scale. Paint-only like every materializing popup; the scrim's fill goes in `style` (a `backing` would not fade).
   */
  appear?: 'dialog' | 'scrim'
}>(function PopupLayer(
  {
    side = 'bottom',
    align = 'start',
    sideOffset = 0,
    collisionPadding = 8,
    kind = 'menu',
    alignOffset = 0,
    position,
    anchor,
    fit = 'snap',
    priority = 1,
    occlude = true,
    still: stillProp = false,
    fade,
    backing,
    materialize,
    leaving = false,
    onLeft,
    appear,
    material = 'popup',
    backdrop: explicitBackdrop,
    style,
    children,
    ...props
  },
  ref,
) {
  const t = useTheme()
  const g = useGlass()
  // Glass scopes (`platform/translucency.ts`, `platform/glass.ts`): whole window → the frost-menu tint over a scene blur (`denseFloat`
  // without the blur when the gate dropped the class); Sidebar only → dense fill, no blur (the layer is transparent over opaque
  // content); Solid and the accessibility overrides → today's opaque popover.
  // A dialog's card frosts like a menu on whole-window glass only; Sidebar only and Solid keep its opaque popover (and its scrim never frosts).
  const glass = t.scope !== 'none' && material !== 'none' && (!appear || (appear === 'dialog' && g.on))
  const radiusPx = typeof (style as StyleDesc | undefined)?.borderRadius === 'number' ? (style as StyleDesc).borderRadius as number : 16
  const menuBackdrop = kind === 'tooltip' ? undefined : frostBackdrop(g, 'menus', radiusPx)
  const blurred = glass && !!menuBackdrop
  const webLayer = useWebOcclusion(undefined, typeof style?.borderRadius === 'number' ? style.borderRadius : 0, backing?.startsWith('rgba(0, 0, 0, ') ? Number(backing.slice(14, -1)) : 0)
  // Decided on mount: a later change must not restart or drop the tween.
  // 'arrive' = paint-only materialize; 'layout' = the `fade` layers' <anchored motion>; 'none' = no motion (`still`, stock addon).
  // A zero-length native opacity motion can leave a layout-tweened popup at its initial opacity 0, so Reduce Motion never uses 'layout'.
  // `KYBERN_POPUP_MOTION=layout` is the measurement control: every popup takes v0.10.1's drift-and-fade layout tween.
  const [mode] = useState<'arrive' | 'layout' | 'none'>(() =>
    fade || LAYOUT_POPUPS ? (stillProp || REDUCED_MOTION ? 'none' : 'layout') : stillProp || !PATCHED_NATIVE ? 'none' : 'arrive')
  const [generation] = useState(nextPresenceGeneration)
  const { duration, ease, distance } = POPUP[kind]
  const d = REDUCED_MOTION ? 0 : distance
  const opacity = fade?.opacity ?? 1
  const from = fade
    ? { top: REDUCED_MOTION ? 0 : (fade.rise ?? 0) }
    : side === 'bottom' ? { top: -d } : side === 'top' ? { top: d } : side === 'right' ? { left: -d } : { left: d }
  const motion = {
    generation,
    isExit: false,
    initial: { opacity: 0, ...from },
    animate: { opacity, top: 0, left: 0 },
    transition: fade ? { duration: DURATION.fast, ease: [...EASE.smoothOut] } : { duration, ease: [...ease] },
  }
  const radius = (style as StyleDesc | undefined)?.borderRadius
  const placement = position
    ? { position, ...(anchor ? { anchor } : {}) }
    : { side, align, gap: sideOffset, offset: side === 'left' || side === 'right' ? { x: 0, y: alignOffset } : { x: alignOffset, y: 0 } }
  // The enter/exit of a materializing popup. `leaving` retargets the same transform to the exit (a new generation without
  // `initial` retargets from the value on screen; completion events carry the generation).
  const exit = appear === 'dialog' ? EXIT.dialog : appear === 'scrim' ? EXIT.backdrop : kind === 'tooltip' ? EXIT.tooltip : EXIT.menu
  const origin = materialize?.origin ?? (position ? ANCHOR_ORIGIN[anchor ?? 'topLeft'] : popupOrigin(side, align))
  const phase = useRef({ leaving: false, generation, mounted: generation })
  if (phase.current.leaving !== leaving) phase.current = { ...phase.current, leaving, generation: nextPresenceGeneration() }
  const arrive = mode === 'arrive' ? (appear ? appearTransform(appear, origin) : popupTransform(origin, kind)) : undefined
  const transform = arrive
    ? presenceTransform({ show: !leaving, enter: arrive, exit, generation: phase.current.generation, fresh: phase.current.generation === phase.current.mounted })
    : undefined
  // Nothing will animate (or can: a hidden window has no native frames), so an owner waiting on `onLeft` must not wait.
  useEffect(() => {
    if (leaving && (!transform || exitsInstantly(exit))) onLeft?.()
  }, [leaving])
  // Materializing: the glass filter moves inside the transformed box (it scales and fades with the popup), and the
  // layer's own backing is transparent. An explicit `{ blur: 0 }` is how an anchored layer asks for that.
  // A leaving popup is already closed: it answers no keys or outside presses (an Enter just after a pointer pick would run
  // the picked item again during the 150 ms exit).
  const { onKeyDown, onKeyUp, onMouseDownOutside, ...rest } = props as typeof props & { onKeyDown?: unknown; onKeyUp?: unknown; onMouseDownOutside?: unknown }
  const input = leaving ? {} : { onKeyDown, onKeyUp, onMouseDownOutside }
  const glassBackdrop = blurred ? explicitBackdrop ?? menuBackdrop : undefined
  // Whole-window glass layers a hairline rim and a top highlight over the tint; a tooltip is dense and plain.
  const layered = glass && g.on && kind !== 'tooltip'
  const innerStyle = glass && (style as StyleDesc | undefined)?.backgroundColor
    ? {
        ...style as StyleDesc,
        // A tooltip is a tint only (no blur under it): the dense float, so the text behind never reads through.
        backgroundColor: kind === 'tooltip' ? (g.on ? g.denseFloat : t.glass.dense) : frostFill(g, 'menus', t.glass.dense, 'frostMenu'),
        ...(layered ? { position: 'relative' as const, borderColor: g.frostRim, boxShadow: undefined } : {}),
      }
    : style
  return (
    <anchored
      backdrop={transform ? { blur: 0 } : glassBackdrop ?? (glass ? { blur: 0 } : undefined)}
      {...((mode === 'layout' ? { motion } : {}) as object)}
      style={{ ...(radius !== undefined ? { borderRadius: radius } : {}), ...(fade?.opacity !== undefined ? { opacity } : {}), ...(backing ? { backgroundColor: backing } : {}) }}
      {...placement}
      fit={fit}
      snapMargin={collisionPadding}
      deferred
      priority={priority}
      occlude={occlude}
    >
      <div testId={webLayer.id} style={{ display: 'flex' }}>
      <div
        {...rest}
        {...(input as object)}
        ref={ref}
        {...(transform ? {
          paintTransform: transform,
          onMotionComplete: (event: { motionGeneration?: number }) => { if (leaving && event.motionGeneration === phase.current.generation) onLeft?.() },
          ...(glassBackdrop ? { backdrop: glassBackdrop } : {}),
        } : {})}
        style={leaving ? { ...innerStyle, pointerEvents: 'none' } : innerStyle}
      >
        {layered && <GlassEdge radius={radiusPx} color={g.frostHighlight} />}
        <WebLayer.Provider value={webLayer.layer}>{children}</WebLayer.Provider>
      </div>
      </div>
    </anchored>
  )
})

/** `text-muted-foreground/N`: the muted ink at N% of its own alpha. */
export function muted(t: Theme, fraction: number): string {
  return ink(t, (t.variant === 'dark' ? 0.58 : 0.598) * fraction)
}

interface Entry {
  key: string
  disabled: boolean
  keepOpen: boolean
  onSelect: () => void
}

interface MenuContextValue {
  active: string | null
  setActive: (key: string | null) => void
  register: (entry: Entry) => () => void
  pick: (key: string) => void
}

const MenuContext = createContext<MenuContextValue | null>(null)

/** Esc belongs to a picker menu while one is open, and for the press that closed it (a window shortcut must not take the same one). */
let openPickers = 0
let pickerClosedAt = -Infinity
export const pickerOwnsEscape = () => openPickers > 0 || performance.now() - pickerClosedAt < 100

export interface PickerMenuProps {
  /** The trigger; receives whether the menu is open. */
  trigger: (open: boolean) => ReactNode
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  /** Fixed panel width (`w-[26rem]`); otherwise `minWidth` and content decide. */
  width?: number
  minWidth?: number
  /** `--picker-menu-body-p`. */
  padding?: number
  /** Gap between rows (`flex flex-col gap-1` in the mode menu). */
  gap?: number
  disabled?: boolean
  testId?: string
  /** Style of the wrapper that holds the trigger (shrink and truncation). */
  rootStyle?: StyleDesc
}

export function PickerMenu({
  trigger,
  children,
  open: openProp,
  onOpenChange,
  side = 'top',
  align = 'start',
  sideOffset = 4,
  width,
  minWidth = 128,
  padding = 4,
  gap = 0,
  disabled,
  testId,
  rootStyle,
}: PickerMenuProps) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  const [active, setActive] = useState<string | null>(null)
  const entries = useRef<Entry[]>([])
  const triggerRef = useRef<PublicInstance | null>(null)
  const pressedWhileOpen = useRef(false)
  const dismissedByOutside = useRef(false)

  useEffect(() => {
    if (!open) return
    openPickers++
    return () => { openPickers--; pickerClosedAt = performance.now() }
  }, [open])

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOwnOpen(next)
      onOpenChange?.(next)
      setActive(null)
      if (!next && triggerRef.current) renderer?.focusElement?.(triggerRef.current.id)
    },
    [openProp, onOpenChange, renderer],
  )

  const register = useCallback((entry: Entry) => {
    entries.current = [...entries.current.filter((e) => e.key !== entry.key), entry]
    return () => {
      entries.current = entries.current.filter((e) => e !== entry)
    }
  }, [])

  const pick = useCallback(
    (key: string) => {
      const entry = entries.current.find((e) => e.key === key)
      if (!entry || entry.disabled) return
      entry.onSelect()
      if (!entry.keepOpen) setOpen(false)
    },
    [setOpen],
  )

  const move = (step: 1 | -1) => {
    const enabled = entries.current.filter((e) => !e.disabled)
    if (!enabled.length) return
    const at = enabled.findIndex((e) => e.key === active)
    const next = at < 0 ? (step > 0 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length
    setActive(enabled[next]!.key)
  }

  const context = useMemo<MenuContextValue>(() => ({ active, setActive, register, pick }), [active, register, pick])

  return (
    <div style={{ display: 'flex', position: 'relative', minWidth: 0, ...rootStyle }}>
      <div
        ref={(el) => {
          triggerRef.current = el
        }}
        testId={testId}
        tabIndex={disabled ? -1 : 0}
        onMouseDown={() => {
          pressedWhileOpen.current = open
        }}
        onClick={() => {
          if (disabled) return
          if (dismissedByOutside.current) {
            dismissedByOutside.current = false
            return
          }
          if (pressedWhileOpen.current) {
            pressedWhileOpen.current = false
            setOpen(false)
            return
          }
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'enter' || e.key === 'space' || e.key === 'down' || e.key === 'up') setOpen(true)
        }}
        style={{ display: 'flex', minWidth: 0, flexShrink: 1 }}
      >
        {trigger(open)}
      </div>
      {open && (
        <PopupLayer
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          tabIndex={0}
          autoFocus
          testId={testId ? `${testId}-menu` : undefined}
          onMouseDownOutside={() => {
            dismissedByOutside.current = true
            queueMicrotask(() => {
              dismissedByOutside.current = false
            })
            setOpen(false)
          }}
          onKeyDown={(e) => {
            // Esc closes the menu only: a dock or dialog around the chip must not take the same press.
            if (e.key === 'escape') { e.preventDefault(); setOpen(false) }
            else if (e.key === 'down' || (e.key === 'n' && e.modifiers?.ctrl)) move(1)
            else if (e.key === 'up' || (e.key === 'p' && e.modifiers?.ctrl)) move(-1)
            else if ((e.key === 'enter' || e.key === 'space') && active) pick(active)
          }}
          style={{
            ...popoverStyle(t),
            display: 'flex',
            flexDirection: 'column',
            gap,
            padding,
            ...(width ? { width, minWidth: width } : { minWidth }),
          }}
        >
          <MenuContext.Provider value={context}>{children}</MenuContext.Provider>
        </PopupLayer>
      )}
    </div>
  )
}

/** A menu row: highlight on hover or keys, instant fill, dims when disabled. */
export function PickerItem({
  id,
  onSelect,
  disabled = false,
  keepOpen = false,
  children,
  style,
  testId,
}: {
  id: string
  onSelect: () => void
  disabled?: boolean
  keepOpen?: boolean
  children: ReactNode | ((state: { active: boolean }) => ReactNode)
  style?: StyleDesc
  testId?: string
}) {
  const t = useTheme()
  const menu = useContext(MenuContext)!
  const select = useRef(onSelect)
  select.current = onSelect
  useLayoutEffect(
    () => menu.register({ key: id, disabled, keepOpen, onSelect: () => select.current() }),
    [menu.register, id, disabled, keepOpen],
  )
  const active = menu.active === id && !disabled
  return (
    <div
      testId={testId}
      onMouseMove={() => {
        if (!disabled && menu.active !== id) menu.setActive(id)
      }}
      onClick={() => menu.pick(id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 26,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 1,
        paddingBottom: 1,
        borderRadius: OPTION_RADIUS,
        cursor: 'default',
        opacity: disabled ? 0.64 : 1,
        ...(active ? { backgroundColor: t.buttonSecondaryHover } : {}),
        ...style,
      }}
    >
      {typeof children === 'function' ? children({ active }) : children}
    </div>
  )
}

/** `MenuGroupLabel`: 12px, muted at 45%, 8px inset, `--picker-section-py`. */
export function PickerLabel({ children }: { children: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6 }}>
      <Label color={muted(t, 0.45)} size={12} lineHeight={16}>
        {children}
      </Label>
    </div>
  )
}

/**
 * A section label between kinds of rows (the `@` picker's Threads, Notes, Attachments; the composer tray's sections): 13px
 * medium, muted at 60%, aligned with the rows' icons (`inset`, the row's own left padding), with more room above a later
 * section than above the first.
 */
export function SectionLabel({ children, first, inset = 10 }: { children: string; first: boolean; inset?: number }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', paddingLeft: inset, paddingRight: inset, paddingTop: first ? SECTION_LABEL.firstTop : SECTION_LABEL.top, paddingBottom: SECTION_LABEL.bottom }}>
      <Label color={muted(t, 0.6)} size={13} weight={500}>
        {children}
      </Label>
    </div>
  )
}
/** `SectionLabel`'s box: its height is `firstTop` or `top`, plus `line` (GPUI's default line height, φ × 13px) and `bottom`. */
export const SECTION_LABEL = { firstTop: 4, top: 10, bottom: 4, line: 13 * 1.618034 } as const

/** `MenuSeparator`: 1px `bg-border`, `--picker-separator-my/mx`. */
export function PickerSeparator() {
  const t = useTheme()
  return <div style={{ height: 1, marginTop: 4, marginBottom: 4, marginLeft: 8, marginRight: 8, backgroundColor: t.border }} />
}

/** The radio indicator: a 12px check (put it after a `flexGrow: 1` label). */
export function CheckMark({ color, visible = true }: { color: string; visible?: boolean }) {
  return (
    <div style={{ display: 'flex', width: 12, height: 12, flexShrink: 0 }}>
      {visible && <Icon source={G.check} size={12} color={color} />}
    </div>
  )
}
