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
  useEffect,
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
import { Kbd } from '../kit/Kbd.tsx'
import { isEmacsCtrl, keyCaps, shortcutLabel } from '../platform/keys.ts'
import { kitOverlayOpen } from '../kit/AlertDialog.tsx'
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_MS } from '../kit/hoverController.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { N } from './glyphs.ts'
import { containsPoint, submenuCorridor, submenuOverlapsParent, type Point } from './menuGeometry.ts'
import { pointerNav } from './store.ts'
import { observeElementBounds } from '../native/layout.ts'

export { muted }

// ---- menus ----
//
// One menu tree per open root (`Menu`, `ContextMenu`): the root panel plus any `MenuSub` panels opened from it, at
// any depth. Pointer decisions are geometric, from the positions native events carry, never from timers racing
// enter/leave notifications: GPUI treats a deferred overlay as a hard hover barrier, so entering a submenu always
// sends its trigger (and the root panel) a leave. A leave whose point lies inside any panel of the tree changes
// nothing; a leave outside all of them closes the submenus (the root stays); hovering a sibling row of an open
// submenu's trigger closes it unless the pointer is inside the safe triangle toward it (Base UI's safePolygon).
// Keys are routed once, at the root panel (native key events bubble from the focused submenu up through the
// root), to the level that owns them: the deepest one the keyboard or pointer last touched.

type MenuKeyEvent = { key?: string; modifiers?: { ctrl: boolean } }
type PointerPayload = { x?: number; y?: number }

interface Entry {
  key: string
  disabled: boolean
  keepOpen: boolean
  onSelect: () => void
  /** A submenu trigger: open its menu (by key: focus moves into it and its first item lights up). */
  openSub?: (byKey: boolean) => void
}

interface ChildHandle {
  key: string
  close: () => void
  /** The pointer is inside the child or on the safe path to it. */
  protects: (point: Point) => boolean
}

interface MenuTree {
  close: () => void
  /** The depth whose handlers get the keys. */
  owner: { current: number }
  levels: Map<number, { onKeyDown: (event: MenuKeyEvent) => void; panel: () => PublicInstance | null; closeChild: () => void; clearActive: () => void }>
  contains: (point: Point) => boolean
  closeSubs: () => void
  /** The latest pointer position any panel or row of the tree reported. */
  last: { current: (Point & { t: number }) | null }
  /** A panel at `depth` lost the pointer (its notification carries no position): decide from `last`. */
  left: (depth: number) => void
  note: (point: PointerPayload | undefined) => void
}

interface MenuContextValue {
  active: string | null
  setActive: (key: string | null) => void
  /** A row was hovered. False when a submenu's safe path protects the pointer (the highlight stays put). */
  hover: (key: string, point?: PointerPayload) => boolean
  register: (entry: Entry) => () => void
  pick: (key: string) => void
  child: { current: ChildHandle | null }
  pending: { current: { key: string; cancel: () => void } | null }
  tree: MenuTree
  depth: number
  focus: () => void
  first: () => void
}

export const MenuContext = createContext<MenuContextValue | null>(null)
/** The root menu is leaving (its exit plays): its submenus leave with it instead of staying on screen at full opacity. */
const MenuLeaving = createContext(false)

/**
 * Whether the last input on a popup came from the keyboard (a key press) rather than the pointer (a press). A keyboard close (Escape, Enter on
 * an item) unmounts at once; a pointer close plays the exit. Updated by the handlers of the popup's panel and trigger.
 */
function useInputKind() {
  const key = useRef(false)
  return { key, byKey: () => { key.current = true }, byPointer: () => { key.current = false } }
}

function useMenuTree(close: () => void): MenuTree {
  const { renderer } = useGpuix()
  const tree = useRef<MenuTree | null>(null)
  if (!tree.current) {
    const levels: MenuTree['levels'] = new Map()
    const last: { current: (Point & { t: number }) | null } = { current: null }
    const panelAt = (point: Point | null) => {
      if (!point) return -1
      for (const [depth, level] of levels) {
        const el = level.panel()
        if (el && containsPoint(renderer?.getElementBounds?.(el.id), point)) return depth
      }
      return -1
    }
    tree.current = {
      close,
      owner: { current: 0 },
      levels,
      contains: (point) => panelAt(point) >= 0,
      closeSubs: () => levels.get(0)?.closeChild(),
      last,
      note: (point) => { if (point?.x !== undefined && point.y !== undefined) last.current = { x: point.x, y: point.y, t: performance.now() } },
      // Native leave notifications carry no position, and GPUI treats an overlay as a hard hover barrier, so entering a
      // submenu also "leaves" its trigger and the root. What the tree itself reports tells them apart: a pointer that moved
      // on within the menu keeps producing moves inside some panel (a beat before or after the leave), whereas a pointer that
      // left produces none, and its last reported point is inside the panel it left. Checked a beat later.
      left: (depth) => {
        const at = performance.now()
        setTimeout(() => {
          const point = last.current
          if (!point || point.t >= at - 5) return
          const inside = panelAt(point)
          if (inside === -1 || inside === depth) {
            levels.get(0)?.closeChild()
            // The pointer is off the menu: no row stays lit, so the keyboard starts from the top again.
            levels.get(0)?.clearActive()
          }
        }, 50)
      },
    }
  }
  tree.current.close = close
  return tree.current
}

function useMenuLevel(tree: MenuTree, depth: number, closeSelf: () => void) {
  const { renderer } = useGpuix()
  const [active, setActive] = useState<string | null>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = active
  const entries = useRef<Entry[]>([])
  const child = useRef<ChildHandle | null>(null)
  const pending = useRef<{ key: string; cancel: () => void } | null>(null)
  const panelRef = useRef<PublicInstance | null>(null)
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
      if (entry.openSub) return entry.openSub(false)
      if (!entry.keepOpen) tree.close()
      entry.onSelect()
    },
    [tree],
  )
  const hover = useCallback(
    (key: string, point?: PointerPayload) => {
      tree.note(point)
      if (pending.current && pending.current.key !== key) pending.current.cancel()
      if (child.current && child.current.key !== key) {
        if (point?.x !== undefined && point.y !== undefined && child.current.protects({ x: point.x, y: point.y })) return false
        child.current.close()
      }
      tree.owner.current = depth
      setActive(key)
      return true
    },
    [tree, depth],
  )
  const move = (step: 1 | -1) => {
    const enabled = entries.current.filter((e) => !e.disabled)
    if (!enabled.length) return
    const at = enabled.findIndex((e) => e.key === activeRef.current)
    const next = at < 0 ? (step > 0 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length
    child.current?.close()
    setActive(enabled[next]!.key)
  }
  const first = useCallback(() => {
    const enabled = entries.current.find((e) => !e.disabled)
    if (enabled) setActive(enabled.key)
  }, [])
  const focus = useCallback(() => {
    tree.owner.current = depth
    const el = panelRef.current
    if (el) renderer?.focusElement?.(el.id)
  }, [tree, depth, renderer])
  const onKeyDown = (e: MenuKeyEvent) => {
    if (e.key === 'escape') return depth > 0 ? closeSelf() : tree.close()
    if (e.key === 'left' && depth > 0) return closeSelf()
    // → opens a submenu from the keyboard, and so do Enter and Space on its trigger (focus moves in, first item lit).
    const sub = entries.current.find((en) => en.key === activeRef.current && en.openSub && !en.disabled)
    if (e.key === 'right' || ((e.key === 'enter' || e.key === 'space') && sub)) {
      sub?.openSub?.(true)
    } else if (e.key === 'down' || (e.key === 'n' && isEmacsCtrl(e.modifiers))) move(1)
    else if (e.key === 'up' || (e.key === 'p' && isEmacsCtrl(e.modifiers))) move(-1)
    else if ((e.key === 'enter' || e.key === 'space') && activeRef.current) pick(activeRef.current)
  }
  useLayoutEffect(() => {
    tree.levels.set(depth, { onKeyDown, panel: () => panelRef.current, closeChild: () => child.current?.close(), clearActive: () => setActive(null) })
  })
  useLayoutEffect(() => () => { tree.levels.delete(depth) }, [tree, depth])
  const context = useMemo<MenuContextValue>(
    () => ({ active, setActive, hover, register, pick, child, pending, tree, depth, focus, first }),
    [active, hover, register, pick, tree, depth, focus, first],
  )
  /** Key handler for the root panel: routes to the level that owns the keys. */
  const route = (e: MenuKeyEvent) => tree.levels.get(tree.owner.current)?.onKeyDown(e)
  return { context, route, panelRef }
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
  fit,
  panel,
  priority,
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
  /** `'switch'` flips to the other side of the trigger when the popup does not fit, like Base UI's collision handling. */
  fit?: 'snap' | 'switch'
  /** Overrides on the menu panel, for a popover opened from a trigger (its radius and padding). */
  panel?: StyleDesc
  /** Layer order: a menu inside a dialog passes 7, like the kit `Select`, to sit above the dialog's card. */
  priority?: number
}) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  // The popup stays mounted through its exit (`leaving`) after a pointer close; a keyboard close unmounts it at once.
  const input = useInputKind()
  const [present, setPresent] = useState(open)
  const instantClose = useRef(false)
  if (open) {
    if (!present) setPresent(true)
    instantClose.current = false
  } else if (present && instantClose.current) setPresent(false)
  const leaving = !open && present
  const triggerRef = useRef<PublicInstance | null>(null)
  const pressedWhileOpen = useRef(false)
  const dismissedByOutside = useRef(false)
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) instantClose.current = input.key.current
      if (openProp === undefined) setOwnOpen(next)
      onOpenChange?.(next)
      if (!next && triggerRef.current) renderer?.focusElement?.(triggerRef.current.id)
    },
    [openProp, onOpenChange, renderer],
  )
  const close = useCallback(() => setOpen(false), [setOpen])
  const tree = useMenuTree(close)
  const menu = useMenuLevel(tree, 0, close)
  // GPUI's own `switch` mirrors the popup around one point (the trigger edge plus the gap), which lands it
  // on top of the trigger. Instead: after the first paint, a popup that was pushed above the trigger's
  // bottom did not fit below, so it opens on the top side when there is room there.
  const popup = menu.panelRef
  const [flipped, setFlipped] = useState(false)
  const shown = open || leaving
  useEffect(() => {
    if (!shown) { setFlipped(false); return }
    if (fit !== 'switch' || side !== 'bottom' || !renderer || !popup.current || !triggerRef.current) return
    let decided = false
    return observeElementBounds(renderer, { id: popup.current.id }, ({ rect }) => {
      const anchor = triggerRef.current && renderer.getElementBounds?.(triggerRef.current.id)
      if (decided || !rect || !anchor) return
      decided = true
      // `rect` is the content box: add the panel's padding and 1px border back.
      const inset = 2 * ((typeof panel?.padding === 'number' ? panel.padding : 4) + 1)
      if (rect.y < anchor.y + anchor.height && anchor.y - sideOffset - (rect.height + inset) >= 8) setFlipped(true)
    })
  }, [shown, fit, side, sideOffset, renderer])
  return (
    <div style={{ display: 'flex', position: 'relative', minWidth: 0, ...rootStyle }}>
      <div
        ref={(el) => {
          triggerRef.current = el
        }}
        testId={testId}
        tabIndex={0}
        onMouseDown={() => {
          input.byPointer()
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
          menu.context.setActive(null)
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          input.byKey()
          if (e.key === 'enter' || e.key === 'space' || e.key === 'down') setOpen(true)
        }}
        style={{ display: 'flex', minWidth: 0, flexShrink: 1, flexGrow: 1 }}
      >
        {trigger(open)}
      </div>
      {(open || leaving) && (
        <PopupLayer
          ref={menu.panelRef}
          side={flipped ? 'top' : side}
          align={align}
          sideOffset={sideOffset}
          fit={fit}
          {...(priority !== undefined ? { priority } : {})}
          tabIndex={0}
          autoFocus
          leaving={leaving}
          onLeft={() => setPresent(false)}
          testId={testId ? `${testId}-menu` : undefined}
          onMouseDownOutside={(e) => {
            // A press inside a submenu panel is outside this one's element but inside the tree.
            if (e.x !== undefined && e.y !== undefined && tree.contains({ x: e.x, y: e.y })) return
            input.byPointer()
            dismissedByOutside.current = true
            queueMicrotask(() => {
              dismissedByOutside.current = false
            })
            setOpen(false)
          }}
          onKeyDown={(e) => { input.byKey(); menu.route(e) }}
          onMouseMove={tree.note}
          onMouseLeave={() => tree.left(0)}
          onMouseDown={() => { input.byPointer(); pointerNav() }}
          style={panel ? { ...panelStyle(t, width, minWidth), ...panel } : panelStyle(t, width, minWidth)}
        >
          <MenuLeaving.Provider value={leaving}>
            <MenuContext.Provider value={menu.context}>{children}</MenuContext.Provider>
          </MenuLeaving.Provider>
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
  // A pointer close (a pick, a press outside) plays the exit and then calls `onClose`; a keyboard close calls it at once.
  const input = useInputKind()
  const [leaving, setLeaving] = useState(false)
  const close = useCallback(() => {
    if (input.key.current) onClose()
    else setLeaving(true)
  }, [onClose, input.key])
  const tree = useMenuTree(close)
  const menu = useMenuLevel(tree, 0, close)
  // The layer carries the panel's radius, as `FloatingLayer` does, or it paints square corners.
  return (
    // It opens down and right from the pointer, so it grows from its top-left corner.
    <PopupLayer
      ref={menu.panelRef}
      position={at}
      fit="switch"
      priority={2}
      testId={testId}
      tabIndex={0}
      autoFocus
      leaving={leaving}
      onLeft={onClose}
      onMouseDownOutside={(e) => {
        if (e.x !== undefined && e.y !== undefined && tree.contains({ x: e.x, y: e.y })) return
        input.byPointer()
        close()
      }}
      onKeyDown={(e) => { input.byKey(); menu.route(e) }}
      onMouseMove={tree.note}
      onMouseLeave={() => tree.left(0)}
      onMouseDown={() => { input.byPointer(); pointerNav() }}
      style={panelStyle(t, undefined, width)}
    >
      <MenuLeaving.Provider value={leaving}>
        <MenuContext.Provider value={menu.context}>{children}</MenuContext.Provider>
      </MenuLeaving.Provider>
    </PopupLayer>
  )
}

/** A menu row: optional 16px icon, label, trailing shortcut or detail. */
export function MenuItem({
  id,
  icon,
  iconNode,
  label,
  description,
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
  /** A second, muted line that says what the item does (the Projects "+" menu); the icon then sits on the first line. */
  description?: string
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
      onMouseMove={(e) => {
        if (!disabled) menu.hover(id, e)
      }}
      onMouseLeave={() => {
        if (menu.active === id) menu.setActive(null)
      }}
      // A row inside a nested overlay only receives its click when it also listens for the press (GPUIX hit routing).
      onMouseDown={() => {}}
      onClick={() => menu.pick(id)}
      style={{
        display: 'flex',
        alignItems: description ? 'flex-start' : 'center',
        gap: 8,
        minHeight: 26,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: description ? 5 : 1,
        paddingBottom: description ? 6 : 1,
        borderRadius: 8,
        opacity: disabled ? 0.64 : 1,
        ...(active ? { backgroundColor: t.buttonSecondaryHover } : {}),
      }}
    >
      {iconNode ?? (icon && <Icon source={icon} size={16} color={destructive ? t.red : ink(t, t.variant === 'dark' ? 0.8 : 0.8)} style={description ? { marginTop: 2 } : undefined} />)}
      {description ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexGrow: 1, minWidth: 0 }}>
          <Label color={color} lineHeight={20} truncate>{label}</Label>
          <Label color={muted(t, 0.72)} size={12} lineHeight={16}>{description}</Label>
        </div>
      ) : (
        <Label color={color} truncate style={{ flexGrow: 1 }}>
          {label}
        </Label>
      )}
      {detail && (
        <Label color={muted(t, 0.72)} size={12} weight={500}>
          {detail}
        </Label>
      )}
      {shortcut && (
        <Label color={muted(t, 0.72)} size={12} weight={500}>
          {shortcutLabel(shortcut)}
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

/**
 * `MenuSub` + `MenuSubTrigger` + `MenuSubPopup`: a row with a trailing chevron that opens a nested menu to its right
 * (to its left when there is no room). Hover opens after 100 ms (Base UI's submenu delay); ArrowRight/Enter open it
 * with the first item lit; ArrowLeft/Escape close it and return to the trigger. The popup sits at the trigger's
 * edge, 5px above its row (`alignOffset -5`: the popup's padding and border), 192px wide like the desktop's.
 */
export function MenuSub({
  id,
  label,
  icon,
  hint,
  trailing,
  children,
  width = 192,
  testId,
  disabled = false,
  maxHeight,
}: {
  id: string
  label: string
  icon?: string
  /** Muted text right after the label ("primary"). */
  hint?: string
  /** Before the chevron (a repository's branch in the composer's branch menu). */
  trailing?: ReactNode
  children: ReactNode
  width?: number
  testId?: string
  disabled?: boolean
  /** Scroll the popup past this height (a long list). */
  maxHeight?: number
}) {
  const t = useTheme()
  const parent = useContext(MenuContext)!
  // The root is closing with an exit: this panel leaves with it (together, not left on screen at full opacity).
  const parentLeaving = useContext(MenuLeaving)
  const { renderer } = useGpuix()
  const [open, setOpen] = useState(false)
  const [byKey, setByKey] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<Point | null>(null)
  const wrapper = useRef<PublicInstance | null>(null)
  const cancelOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = null
    if (parent.pending.current?.key === id) parent.pending.current = null
  }
  const close = useCallback(() => {
    cancelOpen()
    setOpen(false)
    if (parent.child.current?.key === id) parent.child.current = null
    // The submenu's panel unmounts with its focus: the parent panel takes the keys back.
    if (parent.tree.owner.current > parent.depth) parent.focus()
  }, [parent, id])
  const menu = useMenuLevel(parent.tree, parent.depth + 1, () => {
    close()
    parent.setActive(id)
  })
  const protects = (point: Point) => {
    const el = menu.panelRef.current
    return submenuCorridor(origin.current, el ? renderer?.getElementBounds?.(el.id) : null, point)
  }
  const show = (viaKey: boolean) => {
    cancelOpen()
    parent.setActive(id)
    if (parent.child.current && parent.child.current.key !== id) parent.child.current.close()
    parent.child.current = { key: id, close, protects }
    setByKey(viaKey)
    setOpen(true)
    if (viaKey) parent.tree.owner.current = parent.depth + 1
  }
  const showRef = useRef(show)
  showRef.current = show
  useLayoutEffect(
    () => parent.register({ key: id, disabled, keepOpen: true, onSelect: () => showRef.current(true), openSub: (viaKey) => showRef.current(viaKey) }),
    [parent.register, id, disabled],
  )
  // On unmount only: `parent` (the context value) changes whenever the highlight does.
  const parentRef = useRef(parent)
  parentRef.current = parent
  useLayoutEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (parentRef.current.child.current?.key === id) parentRef.current.child.current = null
  }, [id])
  // Opened from the keyboard: light the first item once its rows have registered.
  useLayoutEffect(() => {
    if (open && byKey) menu.context.first()
  }, [open, byKey])
  const lit = open || parent.active === id
  // GPUI's `switch` mirrors the popup onto its own trigger's menu. Kept in the window (`snap`), a popup that did not fit on the
  // right lands over the parent instead, and then opens on the left of the row.
  const [flipped, setFlipped] = useState(false)
  useEffect(() => {
    if (!open) { setFlipped(false); return }
    const popup = menu.panelRef.current
    if (!renderer || !popup || !wrapper.current) return
    let decided = false
    return observeElementBounds(renderer, { id: popup.id }, ({ rect }) => {
      const row = wrapper.current && renderer.getElementBounds?.(wrapper.current.id)
      if (decided || !rect || !row) return
      decided = true
      if (submenuOverlapsParent(rect, row)) setFlipped(true)
    })
  }, [open, renderer])
  // Enter and move do the same: a single synthetic move may arrive as an enter only.
  const hoverTrigger = (e: PointerPayload) => {
    if (disabled) return
    if (e.x !== undefined && e.y !== undefined) origin.current = { x: e.x, y: e.y }
    if (!parent.hover(id, e)) return
    if (!open && !openTimer.current) {
      parent.pending.current = { key: id, cancel: cancelOpen }
      openTimer.current = setTimeout(() => showRef.current(false), 100)
    }
  }
  return (
    <div ref={wrapper} style={{ position: 'relative', display: 'flex', flexDirection: 'column', flexShrink: 0, minHeight: 26 }}>
      <div
        testId={testId}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled}
        onMouseMove={hoverTrigger}
        onMouseEnter={hoverTrigger}
        onMouseDown={() => {}}
        onClick={() => {
          if (!disabled) {
            pointerNav()
            show(false)
          }
        }}
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
          ...(lit && !disabled ? { backgroundColor: t.buttonSecondaryHover } : {}),
        }}
      >
        {icon && <Icon source={icon} size={16} color={ink(t, 0.8)} />}
        <Label color={t.text} truncate style={{ flexGrow: hint ? 0 : 1, flexShrink: 1, pointerEvents: 'none' }}>
          {label}
        </Label>
        {hint && (
          <Label color={muted(t, 0.6)} size={12} style={{ flexGrow: 1, flexShrink: 0, pointerEvents: 'none' }}>
            {hint}
          </Label>
        )}
        {trailing && <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}>{trailing}</div>}
        <Icon source={N.chevronRight} size={16} color={t.text} style={{ marginRight: -2, pointerEvents: 'none' }} />
      </div>
      {open && (
        <PopupLayer
          ref={menu.panelRef}
          side={flipped ? 'left' : 'right'}
          align="start"
          sideOffset={0}
          alignOffset={-5}
          fit="snap"
          priority={parent.depth + 3}
          tabIndex={0}
          autoFocus={byKey}
          leaving={parentLeaving}
          testId={testId ? `${testId}-menu` : undefined}
          onMouseMove={(e) => {
            // The pointer arrived: the corridor did its job, and this menu takes the keys.
            parent.tree.note(e)
            origin.current = null
            parent.tree.owner.current = parent.depth + 1
          }}
          onMouseLeave={() => parent.tree.left(parent.depth + 1)}
          onMouseDown={pointerNav}
          style={panelStyle(t, width)}
        >
          <MenuLeaving.Provider value={parentLeaving}>
            <MenuContext.Provider value={menu.context}>
              {maxHeight ? <div style={{ display: 'flex', flexDirection: 'column', maxHeight, overflow: 'scroll' }}>{children}</div> : children}
            </MenuContext.Provider>
          </MenuLeaving.Provider>
        </PopupLayer>
      )}
    </div>
  )
}

/** `MenuCheckboxItem` (default variant): a row whose trailing 12px check shows while `checked`. Selecting toggles and keeps the menu open. */
export function MenuCheckboxItem({
  id,
  icon,
  label,
  checked,
  onCheckedChange,
  disabled,
  testId,
}: {
  id: string
  icon?: string
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  testId?: string
}) {
  return <MenuItem id={id} icon={icon} label={label} checked={checked} keepOpen disabled={disabled} testId={testId} onSelect={() => onCheckedChange(!checked)} />
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

/** Tooltip box metrics: 13px text, 8px × 4px padding, 1px border; `Kbd` chips are 18px (`kit/Kbd.tsx`). */
const TIP_TEXT_EM = 0.53
const TIP_HEIGHT = 4 * 2 + 17 + 2
const TIP_KBD_HEIGHT = 4 * 2 + 18 + 2

/** Estimated tooltip width; GPUIX cannot measure a layer before it paints. */
function tipWidth(label: string, keys?: string[]) {
  const text = label.length * 13 * TIP_TEXT_EM
  // A one-glyph chip is 18 wide; a word ("Ctrl", "Enter" off macOS) is its 11px text plus 8 padding.
  const kbd = keys?.length ? 8 + keys.reduce((sum, key) => sum + Math.max(18, Math.round(key.length > 1 ? key.length * 11 * 0.6 + 8 : 18)) + 3, 0) - 3 : 0
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
  open: forcedOpen,
}: {
  label: string
  shortcut?: string[]
  side?: 'top' | 'bottom' | 'left' | 'right'
  sideOffset?: number
  /** Show it regardless of hover (a drag target naming where the drop goes). */
  open?: boolean
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
  const open = forcedOpen === true || state.active !== null
  // The tooltip stays mounted for its 80 ms exit after the pointer leaves; one that opened `instant` (a neighbour had just closed) also leaves at once.
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)
  const leaving = !open && present
  if (disabled) return children
  // Labels carry macOS glyphs ("Toggle sidebar (⌘B)"); off macOS they read Ctrl+B (`platform/keys.ts`).
  label = shortcutLabel(label)
  const caps = shortcut && keyCaps(shortcut)
  const vertical = side === 'left' || side === 'right'
  const extent = vertical ? (caps?.length ? TIP_KBD_HEIGHT : TIP_HEIGHT) : tipWidth(label, caps)
  const alignOffset = Math.round((size - extent) / 2)
  return (
    <div style={{ display: 'flex', position: 'relative', alignItems: 'start', flexShrink: 0 }}>
      {/* The control itself is the trigger: a wrapper would be occluded by the
          control's own hover fill and lose the pointer at once. */}
      {hoverTrigger(ctl, true, children, pressed)}
      {(open || leaving) && (
        // `TooltipContent`'s placement, with the surface animated.
        <PopupLayer
          testId="tooltip"
          kind="tooltip"
          still={state.instant || forcedOpen === true}
          leaving={leaving}
          onLeft={() => setPresent(false)}
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
          {caps && <Kbd keys={shortcut!} />}
        </PopupLayer>
      )}
    </div>
  )
}

// ---- dialogs ----

/**
 * A centred dialog (`components/kit/dialog.tsx`): `bg-black/60` over the whole
 * window and an opaque `rounded-3xl` popover card with the light border and
 * lift shadow. Escape and a click outside close. The scrim fades in over
 * `--duration-fast` smooth-out and the card grows from 0.96 with a 2 px blur
 * (`dialog.tsx:27,55`), both paint-only; the exit is 150 ms (the card to 0.98).
 * A pointer close (the X, a press outside) plays the exit and then calls
 * `onClose`; Escape, and `instant` (opened by a shortcut) close at once, and
 * `useDialogClose()` gives the dialog's own buttons the same pointer exit. A
 * caller that unmounts the dialog itself (an action button's `setOpen(false)`)
 * closes at once. `palette` is the command dialog (`rounded-2xl`, raised by
 * `sm:pb-[15vh]`).
 */
const DialogClose = createContext<((after?: () => void) => void) | null>(null)
/**
 * Close the enclosing `Dialog` the way its X button does: the exit plays, then `after` (default: the dialog's `onClose`) runs. A
 * keyboard close should call the plain handler instead. `null` outside a `Dialog`.
 */
export function useDialogClose(): ((after?: () => void) => void) | null {
  return useContext(DialogClose)
}

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
  finalFocus,
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
  /** Override restoration, e.g. focus the opener while preserving its list anchor. */
  finalFocus?: () => void
}) {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 250 })
  const { renderer } = useGpuix()
  const [returnFocus] = useState(() => renderer?.getFocusedElementId?.())
  const focusTarget = useRef(finalFocus)
  focusTarget.current = finalFocus
  useLayoutEffect(() => () => {
    queueMicrotask(() => {
      try {
        if (focusTarget.current) focusTarget.current()
        else if (returnFocus != null) renderer?.focusElement?.(returnFocus)
      } catch { /* Window closed. */ }
    })
  }, [renderer, returnFocus])
  const palette = variant === 'palette'
  // Decided once: a later change must not restart the entrance.
  const [still] = useState(instant)
  const [leaving, setLeaving] = useState(false)
  const closeNow = useRef(onClose)
  closeNow.current = onClose
  const after = useRef<(() => void) | null>(null)
  /** A pointer close: play the exit, then `after` or `onClose` (the card's `onLeft`). */
  const closeWithExit = useCallback((then?: () => void) => {
    after.current = then ?? null
    if (still) (then ?? closeNow.current)()
    else setLeaving(true)
  }, [still])
  // The scrim is the content's own fill (black at `dim`), not the anchored surface's `backing`: it fades with the transform at its
  // true alpha, with no layout tween over the window. The card sits on another layer, its left-centre point placed so the card is
  // centred (palette: raised).
  const cardWidth = Math.min(width, size.width - 32)
  const top = palette ? Math.max(16, size.height * 0.04) : 16
  const bottom = palette ? size.height * 0.15 : 16
  return (
    <>
      <PopupLayer
        still={still}
        material="none"
        appear="scrim"
        materialize={{ origin: [0.5, 0.5] }}
        leaving={leaving}
        position={{ x: 0, y: 0 }}
        priority={3}
        onMouseDown={pointerNav}
        style={{ width: size.width, height: size.height, backgroundColor: `rgba(0, 0, 0, ${dim})` }}
      />
      <PopupLayer
        still={still}
        material="popup"
        appear="dialog"
        materialize={{ origin: [0.5, 0.5] }}
        leaving={leaving}
        onLeft={() => (after.current ?? closeNow.current)()}
        position={{ x: Math.round((size.width - cardWidth) / 2), y: pinTop !== undefined ? pinTop : Math.round((top + size.height - bottom) / 2) }}
        anchor={pinTop !== undefined ? 'topLeft' : 'leftCenter'}
        priority={4}
        testId={testId}
        tabIndex={0}
        autoFocus
        onMouseDown={pointerNav}
        // A kit popup open inside the dialog (select, combobox, sheet) takes Escape and outside presses first.
        onMouseDownOutside={() => {
          if (!kitOverlayOpen()) closeWithExit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'escape' && !kitOverlayOpen()) closeNow.current()
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
        <DialogClose.Provider value={closeWithExit}>{children}</DialogClose.Provider>
      </PopupLayer>
    </>
  )
}

/** `DialogHeader` + `DialogTitle` + `DialogDescription`, with the ghost close button. */
export function DialogHeader({ title, description, onClose }: { title: string; description?: string; onClose: () => void }) {
  const t = useTheme()
  // The X plays the dialog's exit when it can (a pointer press); `onClose` runs when the exit ends.
  const exit = useDialogClose()
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
        onClick={() => (exit ? exit(onClose) : onClose())}
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
