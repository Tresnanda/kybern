import { BACKDROP } from '../native/backdrop.ts'
import { useBackdropMaterial, backdropTint } from '../native/backdrop-material.ts'
// The composer's picker menus (`ComposerPickerMenuPopup` + `components/kit/menu.tsx`,
// "normal" picker size in `kit.css:2960`): a 0.65rem-radius opaque popover with a
// 1px border and the composer's soft shadow, 4px body padding, 26px option rows
// at 8px radius, 12px group labels and 1px separators.
//
// It sits on an `<anchored>` overlay (`PopupLayer`, GPUIX's `FloatingLayer` plus
// motion), so it paints above the transcript. It opens like the desktop's
// `menu.tsx` popup: a 250 ms smooth-out fade that drifts 4px from the trigger
// side (`POPUP.menu` in `motion/kit.tsx`; the scale and blur have no GPUIX
// equivalent), and closes instantly.
// Keyboard: ↑/↓ move the highlight, Enter/Space pick, Escape closes and returns
// focus to the trigger. Nothing is highlighted until the pointer or a key moves,
// like Base UI menus opened with the pointer.
import { useGpuix, type AnchoredProps, type Props, type PublicInstance, type StyleDesc } from '@gpuix/react'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Icon } from '../icons.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import type { Theme } from '../theme.ts'
import { DURATION, EASE, POPUP } from '../motion/kit.tsx'
import { REDUCED_MOTION } from '../ui.tsx'
import { G } from './glyphs.ts'

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

let popupGeneration = 1_000_000

/**
 * `FloatingLayer` (`@gpuix/react/floating`) with the desktop's popup open
 * (`data-starting-style` in `components/kit/menu.tsx` and `popover.tsx`). The
 * tween runs on the `<anchored>` surface itself: it paints its own dark
 * backing under the content, so fading only the content would leave that
 * backing showing for the first frames. `side` is where the popup sits
 * relative to its trigger; it drifts in from the trigger.
 *
 * Also used by the thread panel, rail and title bar (`nav/overlay.tsx`), which
 * add: `kind` (tooltip timing), `position`/`anchor` (context menus at the
 * pointer, centred dialogs), `still` (opened by a shortcut or carried over:
 * no motion), and `fade` (a plain fade to an opacity, optionally rising, for
 * the dialog backdrop and card).
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
    material = 'popup',
    backdrop: explicitBackdrop,
    style,
    children,
    ...props
  },
  ref,
) {
  const glass = useBackdropMaterial()
  const [generation] = useState(() => ++popupGeneration)
  // Decided on mount: a later change must not restart or drop the tween.
  // Reduce Motion skips the tween entirely: a zero-length native opacity motion
  // can leave the popup at its initial opacity 0, so it would never show.
  const [still] = useState(stillProp || REDUCED_MOTION)
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
  return (
    <anchored
      backdrop={material === 'none' || !glass ? undefined : explicitBackdrop ?? {...BACKDROP.glass, radius: radius ?? 16}}
      {...((still ? {} : { motion }) as object)}
      style={{ ...(radius !== undefined ? { borderRadius: radius } : {}), ...(fade?.opacity !== undefined ? { opacity } : {}), ...(backing ? { backgroundColor: backing } : {}) }}
      {...placement}
      fit={fit}
      snapMargin={collisionPadding}
      deferred
      priority={priority}
      occlude={occlude}
    >
      <div {...props} ref={ref} style={glass && material !== 'none' && (style as StyleDesc | undefined)?.backgroundColor ? {...style as StyleDesc,backgroundColor:backdropTint((style as StyleDesc).backgroundColor!)} : style}>
        {children}
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
            if (e.key === 'escape') setOpen(false)
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
