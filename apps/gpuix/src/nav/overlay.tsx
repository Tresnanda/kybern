// Menus, context menus, tooltips and dialogs for the panel, rail and title bar.
// All of them are `<anchored>` layers with opaque fills, so they paint above the
// transcript. The menu chrome is the composer's picker shell (`composer/Menu.tsx`,
// `ComposerPickerMenuPopup`); items add the desktop's leading icon, trailing
// shortcut and destructive tone (`components/kit/menu.tsx`).
//
// Motion (`components/kit/menu.tsx`, `tooltip.tsx`, `dialog.tsx`): menus and
// context menus open with the kit's `POPUP.menu` timing (250 ms smooth-out,
// fading in and drifting 4px from the trigger in place of the desktop's 0.97
// scale and blur); tooltips wait like Base UI's, then fade in over 150 ms
// (`POPUP.tooltip`), at once when a neighbour's just closed (`data-instant`).
// Dialogs fade their backdrop and card in over 250 ms. Everything closes at once.
//
// The tween runs on the `<anchored>` surface itself (the composer's `PopupLayer`):
// GPUIX paints an opaque #1A1A1A backing under every anchored layer, so fading
// only its content would show that backing first.
import { useGpuix, useWindowSize, type PublicInstance, type StyleDesc } from '@gpuix/react'
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { muted, popoverStyle, PopupLayer, surfaceShadow } from '../composer/Menu.tsx'
import { Icon } from '../icons.tsx'
import { hoverTrigger, useHover } from '../kit/hover.tsx'
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_MS } from '../kit/hoverController.ts'
import { DISTANCE } from '../motion/kit.tsx'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { N } from './glyphs.ts'
import { pointerNav } from './store.ts'

export { muted }

// ---- menus ----

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

function useMenuState(close: () => void) {
  const [active, setActive] = useState<string | null>(null)
  const entries = useRef<Entry[]>([])
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
      if (!entry.keepOpen) close()
      entry.onSelect()
    },
    [close],
  )
  const move = (step: 1 | -1) => {
    const enabled = entries.current.filter((e) => !e.disabled)
    if (!enabled.length) return
    const at = enabled.findIndex((e) => e.key === active)
    const next = at < 0 ? (step > 0 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length
    setActive(enabled[next]!.key)
  }
  const context = useMemo<MenuContextValue>(() => ({ active, setActive, register, pick }), [active, register, pick])
  const onKeyDown = (e: { key?: string; modifiers?: { ctrl: boolean } }) => {
    if (e.key === 'escape') close()
    else if (e.key === 'down' || (e.key === 'n' && e.modifiers?.ctrl)) move(1)
    else if (e.key === 'up' || (e.key === 'p' && e.modifiers?.ctrl)) move(-1)
    else if ((e.key === 'enter' || e.key === 'space') && active) pick(active)
  }
  return { context, onKeyDown, setActive }
}


function panelStyle(t: ReturnType<typeof useTheme>, width?: number, minWidth = 128): StyleDesc {
  return {
    ...popoverStyle(t),
    display: 'flex',
    flexDirection: 'column',
    padding: 4,
    ...(width ? { width, minWidth: width } : { minWidth }),
  }
}

/** A menu opened from a trigger (`Menu` + `ComposerPickerMenuPopup`). */
export function Menu({
  trigger,
  children,
  open: openProp,
  onOpenChange,
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  width,
  minWidth,
  testId,
  rootStyle,
}: {
  trigger: (open: boolean) => ReactNode
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  width?: number
  minWidth?: number
  testId?: string
  rootStyle?: StyleDesc
}) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  const triggerRef = useRef<PublicInstance | null>(null)
  const pressedWhileOpen = useRef(false)
  const dismissedByOutside = useRef(false)
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOwnOpen(next)
      onOpenChange?.(next)
      if (!next && triggerRef.current) renderer?.focusElement?.(triggerRef.current.id)
    },
    [openProp, onOpenChange, renderer],
  )
  const close = useCallback(() => setOpen(false), [setOpen])
  const menu = useMenuState(close)
  return (
    <div style={{ display: 'flex', position: 'relative', minWidth: 0, ...rootStyle }}>
      <div
        ref={(el) => {
          triggerRef.current = el
        }}
        testId={testId}
        tabIndex={0}
        onMouseDown={() => {
          pressedWhileOpen.current = open
        }}
        onClick={() => {
          if (dismissedByOutside.current) {
            dismissedByOutside.current = false
            return
          }
          if (pressedWhileOpen.current) {
            pressedWhileOpen.current = false
            return setOpen(false)
          }
          menu.setActive(null)
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          if (e.key === 'enter' || e.key === 'space' || e.key === 'down') setOpen(true)
        }}
        style={{ display: 'flex', minWidth: 0, flexShrink: 1, flexGrow: 1 }}
      >
        {trigger(open)}
      </div>
      {open && (
        <PopupLayer
          side={side}
          align={align}
          sideOffset={sideOffset}
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
          onKeyDown={menu.onKeyDown}
          onMouseDown={pointerNav}
          style={panelStyle(t, width, minWidth)}
        >
          <MenuContext.Provider value={menu.context}>{children}</MenuContext.Provider>
        </PopupLayer>
      )}
    </div>
  )
}

/** A context menu at the pointer (`ContextMenuContent`, `w-48`). */
export function ContextMenu({
  at,
  onClose,
  children,
  width = 192,
  testId,
}: {
  at: { x: number; y: number }
  onClose: () => void
  children: ReactNode
  width?: number
  testId?: string
}) {
  const t = useTheme()
  const menu = useMenuState(onClose)
  // The layer carries the panel's radius, as `FloatingLayer` does, or it paints square corners.
  return (
    // It opens down and right from the pointer, so it drifts in from above.
    <PopupLayer
      position={at}
      fit="switch"
      priority={2}
      testId={testId}
      tabIndex={0}
      autoFocus
      onMouseDownOutside={onClose}
      onKeyDown={menu.onKeyDown}
      onMouseDown={pointerNav}
      style={panelStyle(t, undefined, width)}
    >
      <MenuContext.Provider value={menu.context}>{children}</MenuContext.Provider>
    </PopupLayer>
  )
}

/** A menu row: optional 16px icon, label, trailing shortcut or detail. */
export function MenuItem({
  id,
  icon,
  iconNode,
  label,
  shortcut,
  detail,
  checked,
  destructive,
  disabled = false,
  keepOpen = false,
  onSelect,
  testId,
}: {
  id: string
  icon?: string
  iconNode?: ReactNode
  label: string
  shortcut?: string
  detail?: string
  /** A radio item: shows the 12px check when true. */
  checked?: boolean
  destructive?: boolean
  disabled?: boolean
  keepOpen?: boolean
  onSelect: () => void
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
  const color = destructive ? t.red : t.text
  return (
    <div
      testId={testId}
      onMouseMove={() => {
        if (!disabled && menu.active !== id) menu.setActive(id)
      }}
      onMouseLeave={() => {
        if (menu.active === id) menu.setActive(null)
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
        borderRadius: 8,
        opacity: disabled ? 0.64 : 1,
        ...(active ? { backgroundColor: t.buttonSecondaryHover } : {}),
      }}
    >
      {iconNode ?? (icon && <Icon source={icon} size={16} color={destructive ? t.red : ink(t, t.variant === 'dark' ? 0.8 : 0.8)} />)}
      <Label color={color} truncate style={{ flexGrow: 1 }}>
        {label}
      </Label>
      {detail && (
        <Label color={muted(t, 0.72)} size={12} weight={500}>
          {detail}
        </Label>
      )}
      {shortcut && (
        <Label color={muted(t, 0.72)} size={12} weight={500}>
          {shortcut}
        </Label>
      )}
      {checked !== undefined && (
        <div style={{ display: 'flex', width: 12, height: 12, flexShrink: 0 }}>
          {checked && <Icon source={N.check} size={12} color={t.text} />}
        </div>
      )}
    </div>
  )
}

/** `MenuGroupLabel`. */
export function MenuLabel({ children }: { children: string }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6 }}>
      <Label color={muted(t, 0.45)} size={12} lineHeight={16}>
        {children}
      </Label>
    </div>
  )
}

/** `MenuSeparator`. */
export function MenuSeparator() {
  const t = useTheme()
  return <div style={{ height: 1, marginTop: 4, marginBottom: 4, marginLeft: 8, marginRight: 8, backgroundColor: t.border }} />
}

// ---- tooltips ----

/** Tooltip box metrics: 13px text, 8px × 4px padding, 1px border; `Kbd` chips are 20px. */
const TIP_TEXT_EM = 0.53
const TIP_HEIGHT = 4 * 2 + 17 + 2
const TIP_KBD_HEIGHT = 4 * 2 + 20 + 2

/** Estimated tooltip width; GPUIX cannot measure a layer before it paints. */
function tipWidth(label: string, keys?: string[]) {
  const text = label.length * 13 * TIP_TEXT_EM
  const kbd = keys?.length ? 8 + keys.length * 24 - 4 : 0
  return Math.round(text + kbd + 16 + 2)
}

/**
 * A hover tooltip (`TooltipPopup`): 13px text on the opaque popover, radius 10,
 * 8px × 4px padding, centred on its trigger. GPUIX 0.10.0's `align: "center"`
 * puts the layer's far edge on the trigger's centre, so the layer is
 * start-aligned and offset by half the size difference instead. `size` is the
 * trigger's extent along the alignment axis.
 */
export function Tip({
  label,
  shortcut,
  side = 'top',
  sideOffset = 4,
  size = 28,
  children,
  disabled,
}: {
  label: string
  shortcut?: string[]
  side?: 'top' | 'bottom' | 'left' | 'right'
  sideOffset?: number
  size?: number
  /** One host element (a `div`) that takes the trigger's handlers. */
  children: ReactElement
  disabled?: boolean
}) {
  const t = useTheme()
  // Opening right after a neighbour closed skips the delay and the fade (`data-instant`).
  // The controller keeps one tooltip visible app-wide and applies every leave (R4-1).
  const { ctl, state } = useHover({ delay: TOOLTIP_DELAY_MS, skip: TOOLTIP_SKIP_MS })
  const pressed = useRef(false)
  if (disabled) return children
  const open = state.active !== null
  const vertical = side === 'left' || side === 'right'
  const extent = vertical ? (shortcut?.length ? TIP_KBD_HEIGHT : TIP_HEIGHT) : tipWidth(label, shortcut)
  const alignOffset = Math.round((size - extent) / 2)
  return (
    <div style={{ display: 'flex', position: 'relative', alignItems: 'start', flexShrink: 0 }}>
      {/* The control itself is the trigger: a wrapper would be occluded by the
          control's own hover fill and lose the pointer at once. */}
      {hoverTrigger(ctl, true, children, pressed)}
      {open && (
        // `TooltipContent`'s placement, with the surface animated.
        <PopupLayer
          testId="tooltip"
          kind="tooltip"
          still={state.instant}
          side={side}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          occlude={false}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 4,
            paddingBottom: 4,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.popover,
            boxShadow: surfaceShadow(t),
            pointerEvents: 'none',
          }}
        >
          <Label color={t.text} size={13} lineHeight={17} style={{ whiteSpace: 'nowrap' }}>
            {label}
          </Label>
          {shortcut && <Kbd keys={shortcut} />}
        </PopupLayer>
      )}
    </div>
  )
}

/** `Kbd` / `KbdGroup`: 20px chips, 12px medium muted text on `bg-muted`. */
export function Kbd({ keys }: { keys: string[] }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {keys.map((key) => (
        <div
          key={key}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 20,
            minWidth: 20,
            paddingLeft: 4,
            paddingRight: 4,
            borderRadius: 6,
            backgroundColor: t.v('--muted'),
          }}
        >
          <Label color={muted(t, 1)} size={12} weight={500}>
            {key}
          </Label>
        </div>
      ))}
    </div>
  )
}

// ---- dialogs ----

/**
 * A centred dialog (`components/kit/dialog.tsx`): `bg-black/60` over the whole
 * window and an opaque `rounded-3xl` popover card with the light border and
 * lift shadow. Escape and a click outside close. The backdrop and card fade in
 * over `--duration-fast` smooth-out, the card rising 4px where the desktop
 * scales it from 0.96 with a blur; it closes at once. `instant` (opened by a
 * shortcut) skips the motion. `palette` is the command dialog (`rounded-2xl`,
 * raised by `sm:pb-[15vh]`).
 */
export function Dialog({
  onClose,
  width = 512,
  children,
  testId,
  variant = 'dialog',
  instant = false,
  pinTop,
  radius,
  dim = 0.6,
}: {
  onClose: () => void
  width?: number
  children: ReactNode
  testId?: string
  variant?: 'dialog' | 'palette'
  instant?: boolean
  /** Pin the card's top edge this many px from the window top instead of centring it. */
  pinTop?: number
  radius?: number
  /** Backdrop opacity (black). */
  dim?: number
}) {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 250 })
  const { renderer } = useGpuix()
  const [returnFocus] = useState(() => renderer?.getFocusedElementId?.())
  useLayoutEffect(() => () => {
    if (returnFocus != null) queueMicrotask(() => { try { renderer?.focusElement?.(returnFocus) } catch { /* Window closed. */ } })
  }, [renderer, returnFocus])
  const palette = variant === 'palette'
  // Decided once: a later change must not restart the entrance.
  const [still] = useState(instant)
  // Two layers: an anchored layer paints an opaque dark backing unless the surface
  // carries its own fill, so the scrim is that fill (`backing`, black at `dim`; an
  // opacity tween over the backing composited ~2x too dark on light pages) and the
  // card sits on another layer,
  // its left-centre point placed so the card is centred (palette: raised).
  const cardWidth = Math.min(width, size.width - 32)
  const top = palette ? Math.max(16, size.height * 0.04) : 16
  const bottom = palette ? size.height * 0.15 : 16
  return (
    <>
      <PopupLayer
        still={still}
        material="none"
        fade={{}}
        backing={`rgba(0, 0, 0, ${dim})`}
        position={{ x: 0, y: 0 }}
        priority={3}
        onMouseDown={pointerNav}
        style={{ width: size.width, height: size.height }}
      />
      <PopupLayer
        still={still}
        material={palette ? 'none' : 'popup'}
        fade={{ rise: DISTANCE.micro }}
        position={{ x: Math.round((size.width - cardWidth) / 2), y: pinTop !== undefined ? pinTop : Math.round((top + size.height - bottom) / 2) }}
        anchor={pinTop !== undefined ? 'topLeft' : 'leftCenter'}
        priority={4}
        testId={testId}
        tabIndex={0}
        autoFocus
        onMouseDown={pointerNav}
        onMouseDownOutside={onClose}
        onKeyDown={(e) => {
          if (e.key === 'escape') onClose()
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: cardWidth,
          maxHeight: palette ? 420 : size.height - 32,
          borderRadius: radius ?? (palette ? 16 : 24),
          borderWidth: 1,
          borderColor: t.borderLight,
          backgroundColor: t.popover,
          boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 50, spreadRadius: -12, color: t.variant === 'dark' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.34)' },
          overflow: 'hidden',
        }}
      >
        {children}
      </PopupLayer>
    </>
  )
}

/** `DialogHeader` + `DialogTitle` + `DialogDescription`, with the ghost close button. */
export function DialogHeader({ title, description, onClose }: { title: string; description?: string; onClose: () => void }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, paddingRight: 48, paddingTop: 16, paddingBottom: 8, position: 'relative' }}>
      <Label color={t.text} size={18} weight={600} lineHeight={22}>
        {title}
      </Label>
      {description && (
        <Label color={muted(t, 1)} size={14} lineHeight={19}>
          {description}
        </Label>
      )}
      <div
        testId="dialog-close"
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 10,
          cursor: 'pointer',
          hover: { backgroundColor: t.buttonSecondaryHover },
        }}
      >
        <Icon source={N.x} size={16} color={t.iconSecondary} />
      </div>
    </div>
  )
}
