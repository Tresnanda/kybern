// `components/kit/select.tsx` on GPUIX: the trigger (`SelectTrigger` sizes and variants, `SelectValue`) and the
// popup (`SelectPopup` on the `settings` or `composer` surface, items with the check indicator, group labels,
// separators). Options are data (`SelectEntry[]`) so the popup can be placed before it paints.
//
// Measured in the desktop gallery (`scripts/kit9-overlays-probe.mjs`):
// - Trigger: 32px (`lg` 36, `sm` 28, `xs` 24), 11px side padding inside a 1px `--color-border` (sm 9, xs 7),
//   radius 8 (xs 6), `--color-background-control-opaque` fill, 14/21 text (xs 12/18), a 12px chevron at 50%.
//   `ghost`: no border or fill, secondary text, the elevated fill and primary text on hover. Placeholder in
//   `text-muted-foreground`. Disabled at 64%.
// - `settings` surface: radius 10, 1px border, `bg-popover`, the composer shadow, no body padding, 21px rows
//   (10px sides, radius 10). `composer` surface (`ComposerPickerSelectPopup`): radius 10.4, 4px body padding,
//   26px rows (8px sides, radius 8). Group labels 12/18 medium muted, 8/6 padding; separators 1px with 8/4
//   margins. The highlighted row takes `--color-background-button-secondary-hover`; the selected one a 12px
//   check. Disabled rows at 64%.
// - Placement: `alignItemWithTrigger` (the desktop default, mouse-opened) lays the popup over the trigger with
//   the selected row's text on the trigger's value text (popup 1px right of the trigger, rows `anchor + 20`
//   wide), kept 10px inside the window. Otherwise it opens 4px below (`side`/`align`, composer: `end`).
// - Motion: the desktop popup has no transition classes (`document.getAnimations()` is empty while it opens and
//   closes). GPUIX adds a small one for popups opened with the pointer (the motion phase asks for more life than
//   the desktop has): a paint-only scale from 0.98 with an opacity fade, 150 ms `--ease-out` in and 80 ms out,
//   about the trigger side (about the selected row's centre when the popup is laid over the trigger). A popup
//   opened from the keyboard (Enter, Space, ↑/↓) and every close by key appear and disappear at once.
//
// Keyboard (Base UI Select): on the trigger Enter, Space, ↓ and ↑ open; a typed letter selects the next
// matching option without opening. In the popup ↑/↓, Home/End move the highlight (skipping disabled rows), a
// typed prefix jumps to a match, Enter/Space pick, Escape and Tab close. Focus returns to the trigger.
// Escape belongs to the innermost overlay (`useEscapeLayer`): a select inside a sheet closes first.
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { muted, PopupLayer, surfaceShadow } from '../composer/Menu.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { useSettingsModal } from '../settings/controls.tsx'
import { Label, useTheme } from '../ui.tsx'
import { raisedFill, raisedRim, useGlass } from '../platform/glass.ts'
import { useEscapeLayer } from './AlertDialog.tsx'
import { SelectTrigger } from './SelectTrigger.tsx'

export type SelectOption = { value: string; label: string; disabled?: boolean }
export type SelectEntry = SelectOption | { group: string } | { separator: true }
const isOption = (e: SelectEntry): e is SelectOption => 'value' in e

/** The desktop item indicator: its own 24² check path at stroke 2, drawn at 12px. */
export const SELECT_CHECK = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5.252 12.7 10.2 18.63 18.748 5.37" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** The control heights (`kit/controls.ts`): the trigger is `SelectTrigger`, the secondary button's fill. */
const TRIGGER = {
  lg: { height: 32, size: 'lg' },
  default: { height: 32, size: 'lg' },
  sm: { height: 28, size: 'md' },
  xs: { height: 24, size: 'sm' },
} as const

const SURFACE = {
  settings: { radius: 10, pad: 0, row: 21, rowPx: 10, rowRadius: 10, gap: 12 },
  composer: { radius: 10.4, pad: 4, row: 26, rowPx: 8, rowRadius: 8, gap: 8 },
} as const
const LABEL_H = 30
const SEPARATOR_H = 9
/** Base UI keeps an item-aligned popup this far inside the window. */
const EDGE = 10

export function Select({
  options,
  value: valueProp,
  defaultValue = null,
  onValueChange,
  placeholder,
  size = 'default',
  variant = 'default',
  disabled = false,
  surface = 'settings',
  alignItemWithTrigger,
  side = 'bottom',
  align,
  sideOffset = 4,
  width,
  label,
  testId,
}: {
  options: readonly SelectEntry[]
  value?: string | null
  defaultValue?: string | null
  onValueChange?: (value: string) => void
  placeholder?: string
  size?: keyof typeof TRIGGER
  variant?: 'default' | 'ghost'
  disabled?: boolean
  /** `SelectPopup surface` (`settings`) or `ComposerPickerSelectPopup` (`composer`). */
  surface?: keyof typeof SURFACE
  /** Default: true on `settings` (SelectPopup), false on `composer` (ComposerPickerSelectPopup). */
  alignItemWithTrigger?: boolean
  side?: 'top' | 'bottom'
  /** Default: `start` (settings), `end` (composer). */
  align?: 'start' | 'end'
  sideOffset?: number
  /** Trigger width; default variant otherwise fills its row (`w-full min-w-36`), ghost hugs its text. */
  width?: number
  /** Accessible name of the trigger. */
  label?: string
  /** Base id: `<id>-trigger`, `<id>-popup`, `<id>-option-<value>`. */
  testId?: string
}) {
  const t = useTheme()
  const g = useGlass()
  const { renderer } = useGpuix()
  const [own, setOwn] = useState(defaultValue)
  const value = valueProp !== undefined ? valueProp : own
  const [open, setOpenState] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null)
  const triggerRef = useRef<PublicInstance | null>(null)
  const rootRef = useRef<PublicInstance | null>(null)
  const pressedWhileOpen = useRef(false)
  const dismissedByOutside = useRef(false)
  const typed = useRef({ text: '', at: 0 })
  // The scrolling listbox, and whether the highlight last moved by keyboard or by opening (then it is scrolled into view).
  const listRef = useRef<PublicInstance | null>(null)
  const reveal = useRef(false)
  const escape = useEscapeLayer(open)
  useSettingsModal(open)
  // Motion only for a popup the pointer opened and closed. `key` is the last input kind (a key press or a mouse press); the
  // popup stays mounted through its exit (`leaving`) unless the close came from the keyboard.
  const key = useRef(false)
  const [still, setStill] = useState(false)
  const [present, setPresent] = useState(false)
  const instantClose = useRef(false)
  if (open) {
    if (!present) setPresent(true)
    instantClose.current = false
  } else if (present && instantClose.current) setPresent(false)
  const leaving = !open && present

  const s = SURFACE[surface]
  const m = TRIGGER[size]
  const aligned = alignItemWithTrigger ?? surface === 'settings'
  const enabled = options.filter(isOption).filter((o) => !o.disabled)
  const selected = options.find((o): o is SelectOption => isOption(o) && o.value === value)

  const focusTrigger = () => { if (triggerRef.current) renderer?.focusElement?.(triggerRef.current.id) }
  const setOpen = (next: boolean) => {
    if (next) {
      // The padding-free wrapper: a padded element's reported bounds start at its content box.
      const b = rootRef.current ? renderer?.getElementBounds?.(rootRef.current.id) : null
      setAt(b ? { x: b.x, y: b.y, w: b.width } : null)
      // Base UI highlights the selected option when the popup opens.
      setActive(selected && !selected.disabled ? selected.value : null)
      reveal.current = true
      setStill(key.current)
    } else instantClose.current = key.current
    setOpenState(next)
    if (!next) focusTrigger()
  }
  const commit = (next: string) => {
    if (valueProp === undefined) setOwn(next)
    if (next !== value) onValueChange?.(next)
  }
  const pick = (v: string) => { const o = enabled.find((e) => e.value === v); if (!o) return; commit(v); setOpen(false) }
  const move = (to: 'next' | 'prev' | 'first' | 'last') => {
    if (!enabled.length) return
    const i = enabled.findIndex((o) => o.value === active)
    const n = to === 'first' ? 0 : to === 'last' ? enabled.length - 1 : i < 0 ? (to === 'next' ? 0 : enabled.length - 1) : Math.min(enabled.length - 1, Math.max(0, i + (to === 'next' ? 1 : -1)))
    setActive(enabled[n]!.value)
    reveal.current = true
  }
  /** Type-ahead: keys within 500 ms extend the prefix; returns the match after `from`. */
  const typeahead = (char: string, from: string | null) => {
    const now = Date.now()
    typed.current = { text: now - typed.current.at < 500 ? typed.current.text + char : char, at: now }
    const q = typed.current.text.toLowerCase()
    const start = Math.max(0, enabled.findIndex((o) => o.value === from))
    const order = [...enabled.slice(start + (q.length === 1 ? 1 : 0)), ...enabled.slice(0, start + (q.length === 1 ? 1 : 0))]
    return order.find((o) => o.label.toLowerCase().startsWith(q))
  }
  const printable = (e: { key?: string; keyChar?: string; modifiers?: { cmd?: boolean; ctrl?: boolean; alt?: boolean } }) => {
    const c = e.keyChar ?? (e.key && e.key.length === 1 ? e.key : '')
    return c && c.length === 1 && c !== ' ' && !e.modifiers?.cmd && !e.modifiers?.ctrl ? c : null
  }

  // Popup height (for keeping an item-aligned popup inside the window) and the selected row's offset in it.
  const rowsHeight = (until?: string) => {
    let h = 0
    for (const e of options) {
      if (isOption(e) && e.value === until) return h
      h += isOption(e) ? s.row : 'group' in e ? LABEL_H : SEPARATOR_H
    }
    return h
  }
  const windowH = renderer?.getWindowSize?.()?.height ?? 820
  const maxHeight = Math.min(448, windowH - EDGE * 2)
  // A long list scrolls inside `maxHeight`; place it by its visible height, not its content height.
  const popupHeight = Math.min(maxHeight, rowsHeight() + s.pad * 2 + 2)
  const anchorValue = (selected && !selected.disabled ? selected : enabled[0])?.value
  // A keyboard move (or opening) past the visible rows scrolls the highlighted row into view; pointer moves do not.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!open || !active || !reveal.current || !list) return
    reveal.current = false
    const scroll = renderer?.getScrollOffset?.(list.id)
    if (!scroll) return
    const top = -(scroll[1] ?? 0), viewport = popupHeight - 2
    const rowTop = s.pad + rowsHeight(active), rowBottom = rowTop + s.row
    const next = rowTop < top + s.pad ? rowTop - s.pad : rowBottom > top + viewport - s.pad ? rowBottom - viewport + s.pad : top
    if (next !== top) renderer?.scrollTo?.(list.id, 0, -Math.max(0, next))
  }, [open, active, renderer])

  const triggerText = selected?.label ?? placeholder ?? ''

  return (
    <div ref={(el) => { rootRef.current = el }} style={{ display: 'flex', position: 'relative', minWidth: 0, ...(width ? { width } : variant === 'default' ? { flexGrow: 1, minWidth: 144 } : {}) }}>
      <SelectTrigger
        triggerRef={(el) => { triggerRef.current = el }}
        testId={testId ? `${testId}-trigger` : undefined}
        label={label ?? triggerText}
        size={m.size}
        open={open}
        disabled={disabled}
        placeholder={!selected}
        width="100%"
        input={{
          role: 'combobox', tabIndex: disabled ? -1 : 0,
          onMouseDown: () => { key.current = false; pressedWhileOpen.current = open },
          onClick: () => {
            if (disabled) return
            if (dismissedByOutside.current) { dismissedByOutside.current = false; return }
            if (pressedWhileOpen.current) { pressedWhileOpen.current = false; setOpen(false); return }
            setOpen(!open)
          },
          onKeyDown: (e: { key: string }) => {
            key.current = true
            if (disabled || open) return
            if (e.key === 'enter' || e.key === 'space' || e.key === 'down' || e.key === 'up') return setOpen(true)
            const c = printable(e as never)
            const hit = c ? typeahead(c, value) : undefined
            if (hit) commit(hit.value)
          },
        }}
        style={variant === 'ghost' ? { backgroundColor: 'rgba(0, 0, 0, 0)' } : undefined}
      >{triggerText}</SelectTrigger>
      {(open || leaving) && (
        <PopupLayer
          {...(aligned && at
            ? (() => {
                const y = Math.max(EDGE, Math.min(windowH - EDGE - popupHeight, at.y + (m.height - s.row) / 2 - 1 - s.pad - rowsHeight(anchorValue)))
                // Laid over the trigger: grow about the selected row's centre, which sits on the trigger's.
                const originY = Math.min(1, Math.max(0, (at.y + m.height / 2 - y) / popupHeight))
                return { position: { x: at.x + 1, y }, anchor: 'topLeft' as const, materialize: { origin: [0, originY] as [number, number] } }
              })()
            : { side, align: align ?? (surface === 'composer' ? 'end' : 'start'), sideOffset })}
          kind="tooltip"
          material="none"
          still={still}
          leaving={leaving}
          onLeft={() => setPresent(false)}
          fit="snap"
          priority={7}
          testId={testId ? `${testId}-popup` : undefined}
          ref={(el: PublicInstance | null) => { listRef.current = el }}
          role="listbox"
          tabIndex={0}
          autoFocus
          onMouseDown={() => { key.current = false }}
          onMouseDownOutside={() => {
            key.current = false
            dismissedByOutside.current = true
            queueMicrotask(() => { dismissedByOutside.current = false })
            setOpen(false)
          }}
          onKeyDown={(e) => {
            key.current = true
            if (e.key === 'escape') { if (escape.claim()) setOpen(false) }
            else if (e.key === 'tab') setOpen(false)
            else if (e.key === 'down') move('next')
            else if (e.key === 'up') move('prev')
            else if (e.key === 'home') move('first')
            else if (e.key === 'end') move('last')
            else if ((e.key === 'enter' || e.key === 'space') && active) pick(active)
            else {
              const c = printable(e)
              const hit = c ? typeahead(c, active) : undefined
              if (hit) { setActive(hit.value); reveal.current = true }
            }
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: aligned && at ? at.w + 22 : (at?.w ?? (width ?? 144)),
            maxHeight,
            padding: s.pad,
            borderRadius: s.radius,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.v('--popover'),
            boxShadow: surfaceShadow(t),
            overflowY: 'scroll',
          }}
        >
            {options.map((e, i) => {
              if (!isOption(e)) {
                if ('group' in e) return (
                  <div key={`g${i}`} style={{ display: 'flex', paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, flexShrink: 0 }}>
                    <Label color={muted(t, 1)} size={12} lineHeight={18} weight={500}>{e.group}</Label>
                  </div>
                )
                return <div key={`s${i}`} style={{ height: 1, flexShrink: 0, marginLeft: 8, marginRight: 8, marginTop: 4, marginBottom: 4, backgroundColor: t.border }} />
              }
              const on = active === e.value && !e.disabled
              return (
                <div
                  key={e.value}
                  testId={testId ? `${testId}-option-${e.value}` : undefined}
                  role="option"
                  aria-selected={e.value === value}
                  onMouseMove={() => { if (!e.disabled && active !== e.value) setActive(e.value) }}
                  onClick={() => { if (!e.disabled) pick(e.value) }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: s.gap,
                    flexShrink: 0,
                    minHeight: s.row,
                    paddingLeft: s.rowPx,
                    paddingRight: s.rowPx,
                    borderRadius: s.rowRadius,
                    opacity: e.disabled ? 0.64 : 1,
                    ...(on ? { backgroundColor: t.buttonSecondaryHover } : {}),
                  }}
                >
                  <Label color={t.text} size={14} lineHeight={21} truncate style={{ flexGrow: 1, pointerEvents: 'none' }}>{e.label}</Label>
                  <div style={{ display: 'flex', width: 12, height: 12, flexShrink: 0, pointerEvents: 'none' }}>
                    {e.value === value && <Icon source={SELECT_CHECK} size={12} color={t.text} />}
                  </div>
                </div>
              )
            })}
        </PopupLayer>
      )}
    </div>
  )
}

/** Keep a host's own Escape (a page, a dialog that is not a kit overlay) from firing while a kit popup is open. */
export { kitOverlayOpen } from './AlertDialog.tsx'

