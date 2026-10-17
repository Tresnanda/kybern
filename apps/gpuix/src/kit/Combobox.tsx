// `components/kit/combobox.tsx` on GPUIX: a text input that filters a popup list (`ComboboxInput` with its
// trigger or clear button, `ComboboxPopup`, `ComboboxList`/`ComboboxItem`, `ComboboxEmpty`), and the
// `multiple` form with chips (`ComboboxChips`, `ComboboxChip`, `ComboboxChipsInput`).
//
// Measured in the desktop gallery (`scripts/kit9-overlays-probe.mjs`):
// - Input: 32px control, radius 10, 1px `--color-border` (`foreground/30` while focused), `input/32` fill in dark
//   and `--background` in light; 14/21 text with 12px padding (28px on the right beside a button). The
//   trigger (`UnfoldMore`) or clear (`X`) button is 28px, radius 8, 2px from the right edge, its 16px glyph
//   at 80% (100% on hover).
// - Chips: 32px minimum, radius 10, 1px border, `--color-background-control-opaque`, 3px padding, 4px gaps; the
//   focused field takes the focus border and a 3px `--color-border-focus`/24 ring. Chip: 24px, radius 7,
//   `--color-background-elevated-secondary`, 12/16 medium, 8px left padding, a 26px remove button (14px X at 80%).
// - Popup: under the input's text box (1px in from the control, 2.5px below it; for chips 4px under the
//   field), as wide as that anchor; radius 10, 1px border, `bg-popover`, `shadow-lg/5`. List padding 4,
//   rows 24px (10px sides, radius 10, 12px gap, 14/20) with a 12px check on selected rows; the highlighted row
//   takes `--color-background-button-secondary-hover`. Empty: 8px padding, centred 14/20 muted. Max 368px.
// - Motion: none. `ComboboxPopup` declares `transition-[scale,opacity]` but no starting or ending style, so
//   the desktop popup appears and disappears at once (`document.getAnimations()` is empty); so does this one.
//
// Behaviour (Base UI Combobox): a click or typing opens the list, filtered by "contains" (case-insensitive);
// nothing is highlighted until ↓/↑ or the pointer; Enter picks the highlighted row (single: fills the input
// and closes; multiple: toggles a chip and keeps the list open). Escape closes the list (innermost overlay
// first, `useEscapeLayer`), Tab closes it, Backspace in an empty chips input removes the last chip. Leaving a
// single combobox restores the input to its selected value.
import { Tick02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useRef, useState } from 'react'
import { muted } from '../composer/Menu.tsx'
import { glyph, Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { FONT_UI } from '../theme.ts'
import { ink, Label, useTheme } from '../ui.tsx'
import { useEscapeLayer } from './AlertDialog.tsx'

const UNFOLD = glyph(UnfoldMoreIcon)
const CHECK = glyph(Tick02Icon)
const ROW = 24
const MAX_HEIGHT = 368

type Value = string | null | string[]

export function Combobox({
  items,
  value: valueProp,
  defaultValue,
  onValueChange,
  multiple = false,
  placeholder,
  showTrigger = true,
  showClear = false,
  emptyText = 'No results found.',
  disabled = false,
  width,
  itemToLabel = (item) => item,
  filter,
  label,
  testId,
}: {
  items: readonly string[]
  value?: Value
  defaultValue?: Value
  onValueChange?: (value: Value) => void
  multiple?: boolean
  placeholder?: string
  showTrigger?: boolean
  showClear?: boolean
  /** `ComboboxEmpty` children. */
  emptyText?: string
  disabled?: boolean
  /** Field width; default fills its container (`w-full`). */
  width?: number
  itemToLabel?: (item: string) => string
  /** Default: case-insensitive "contains" on the label. */
  filter?: (item: string, query: string) => boolean
  label?: string
  /** Base id: `<id>-input` (`<id>-chips`, `<id>-chips-input`, `<id>-chip-<v>`), `<id>-popup`, `<id>-option-<v>`, `<id>-trigger`, `<id>-clear`. */
  testId?: string
}) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const [own, setOwn] = useState<Value>(defaultValue ?? (multiple ? [] : null))
  const value = valueProp !== undefined ? valueProp : own
  const selectedList = Array.isArray(value) ? value : value ? [value] : []
  const [input, setInput] = useState(!multiple && typeof value === 'string' ? itemToLabel(value) : '')
  const [open, setOpenState] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [anchorW, setAnchorW] = useState<number | null>(null)
  const fieldRef = useRef<PublicInstance | null>(null)
  const inputRef = useRef<PublicInstance | null>(null)
  const dismissedByOutside = useRef(false)
  const escape = useEscapeLayer(open)

  const singleLabel = !multiple && typeof value === 'string' ? itemToLabel(value) : ''
  // Opening on a filled single combobox lists everything (the text is the selection, not a query).
  const query = !multiple && input === singleLabel ? '' : input
  const matches = (item: string) => (filter ? filter(item, query) : itemToLabel(item).toLowerCase().includes(query.toLowerCase()))
  const shown = query ? items.filter(matches) : [...items]

  const setValue = (next: Value) => { if (valueProp === undefined) setOwn(next); onValueChange?.(next) }
  const setOpen = (next: boolean) => {
    if (next && !open) {
      const b = fieldRef.current ? renderer?.getElementBounds?.(fieldRef.current.id) : null
      setAnchorW(b ? b.width : null)
      // Base UI highlights the last chosen chip when a multiple combobox opens; a single one starts clear.
      setActive(multiple && selectedList.length ? selectedList[selectedList.length - 1]! : null)
    }
    if (!next && !multiple) setInput(singleLabel)
    setOpenState(next)
  }
  const focusInput = () => { if (inputRef.current) renderer?.focusElement?.(inputRef.current.id) }
  const pick = (item: string) => {
    if (multiple) {
      setValue(selectedList.includes(item) ? selectedList.filter((v) => v !== item) : [...selectedList, item])
      setInput('')
      return
    }
    setValue(item)
    setInput(itemToLabel(item))
    setOpenState(false)
  }
  const move = (step: 1 | -1) => {
    if (!shown.length) return
    const i = active ? shown.indexOf(active) : -1
    setActive(shown[i < 0 ? (step > 0 ? 0 : shown.length - 1) : Math.min(shown.length - 1, Math.max(0, i + step))]!)
  }
  const onKeyDown = (e: { key?: string }) => {
    if (disabled) return
    if (e.key === 'down') { if (!open) setOpen(true); else move(1) }
    else if (e.key === 'up') { if (!open) setOpen(true); else move(-1) }
    else if (e.key === 'escape') { if (open && escape.claim()) setOpen(false) }
    else if (e.key === 'tab') { if (open) setOpen(false) }
    else if (e.key === 'backspace' && multiple && input === '' && selectedList.length) setValue(selectedList.slice(0, -1))
  }

  const inputField = (chips: boolean) => (
    <input
      ref={(el) => { inputRef.current = el }}
      testId={testId ? `${testId}-${chips ? 'chips-input' : 'input'}` : undefined}
      aria-label={label ?? placeholder}
      tabIndex={disabled ? -1 : 0}
      value={input}
      placeholder={chips && selectedList.length ? '' : placeholder}
      readOnly={disabled}
      theme={{ caret: t.text, textMuted: muted(t, 0.72) }}
      onChange={(e) => {
        setInput(e.value ?? '')
        if (!open) setOpen(true)
        setActive(null)
      }}
      onSubmit={() => { if (open && active) pick(active) }}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={() => { if (!disabled && !open) setOpen(true) }}
      style={chips
        ? { flexGrow: 1, flexShrink: 1, width: 48, minWidth: 48, height: 24, paddingLeft: selectedList.length ? 2 : 8, fontFamily: FONT_UI, fontSize: 14, lineHeight: 20, color: t.text, backgroundColor: 'rgba(0, 0, 0, 0)', borderWidth: 0 }
        : { flexGrow: 1, minWidth: 0, height: 30, paddingLeft: 12, paddingRight: showTrigger || showClear ? 28 : 12, fontFamily: FONT_UI, fontSize: 14, lineHeight: 21, color: t.text, backgroundColor: 'rgba(0, 0, 0, 0)', borderWidth: 0 }}
    />
  )

  const button = (kind: 'trigger' | 'clear') => (
    <div
      testId={testId ? `${testId}-${kind}` : undefined}
      role="button"
      aria-label={kind === 'clear' ? 'Clear' : 'Open'}
      onClick={() => {
        if (disabled) return
        if (kind === 'clear') { setValue(multiple ? [] : null); setInput(''); focusInput(); return }
        if (dismissedByOutside.current) { dismissedByOutside.current = false; return }
        setOpen(!open)
        focusInput()
      }}
      style={{ position: 'absolute', right: 2, top: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, opacity: 0.8, cursor: 'pointer', hover: { opacity: 1 } }}
    >
      <Icon source={kind === 'clear' ? N.x : UNFOLD} size={16} color={t.text} style={{ pointerEvents: 'none' }} />
    </div>
  )

  const popup = open && (
    <anchored
      side="bottom"
      align="start"
      gap={multiple ? 4 : 2.5}
      offset={{ x: multiple ? 0 : 1, y: 0 }}
      fit="snap"
      snapMargin={8}
      deferred
      priority={7}
      style={{ borderRadius: 10 }}
    >
      <div style={{ display: 'flex', borderRadius: 10, boxShadow: { offsetX: 0, offsetY: 10, blurRadius: 15, spreadRadius: -3, color: 'rgba(0, 0, 0, 0.05)' } }}>
        <div
          testId={testId ? `${testId}-popup` : undefined}
          role="listbox"
          onMouseDownOutside={() => {
            dismissedByOutside.current = true
            queueMicrotask(() => { dismissedByOutside.current = false })
            setOpen(false)
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: anchorW !== null ? anchorW - (multiple ? 0 : 2) : undefined,
            maxHeight: MAX_HEIGHT,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.v('--popover'),
            boxShadow: { offsetX: 0, offsetY: 4, blurRadius: 6, spreadRadius: -4, color: 'rgba(0, 0, 0, 0.05)' },
            overflow: 'hidden',
          }}
        >
          {shown.length === 0 ? (
            <div testId={testId ? `${testId}-empty` : undefined} style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
              <Label color={muted(t, 1)} size={14} lineHeight={20}>{emptyText}</Label>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', padding: 4, overflowY: 'scroll', minHeight: 0, flexShrink: 1 }}>
              {shown.map((item) => {
                const on = item === active
                return (
                  <div
                    key={item}
                    testId={testId ? `${testId}-option-${item}` : undefined}
                    role="option"
                    aria-selected={selectedList.includes(item)}
                    onMouseMove={() => { if (active !== item) setActive(item) }}
                    onMouseLeave={() => { if (active === item) setActive(null) }}
                    onClick={() => { pick(item); focusInput() }}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: ROW, flexShrink: 0, paddingLeft: 10, paddingRight: 10, paddingTop: 1, paddingBottom: 1, borderRadius: 10, ...(on ? { backgroundColor: t.buttonSecondaryHover } : {}) }}
                  >
                    <Label color={t.text} size={14} lineHeight={20} truncate style={{ flexGrow: 1, pointerEvents: 'none' }}>{itemToLabel(item)}</Label>
                    {selectedList.includes(item) && <Icon source={CHECK} size={12} color={t.text} style={{ pointerEvents: 'none' }} />}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </anchored>
  )

  if (multiple) {
    const focus = t.v('--color-border-focus')
    return (
      <div
        ref={(el) => { fieldRef.current = el }}
        testId={testId ? `${testId}-chips` : undefined}
        onClick={() => { if (!disabled) { focusInput(); if (!open) setOpen(true) } }}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 4,
          position: 'relative',
          minHeight: 32,
          ...(width ? { width } : { width: '100%' }),
          padding: 3,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: focused ? focus : t.border,
          backgroundColor: t.v('--color-background-control-opaque'),
          opacity: disabled ? 0.64 : 1,
          ...(focused ? { boxShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 3, color: withAlpha(focus, 0.24) } } : {}),
        }}
      >
        {selectedList.map((v) => (
          <div key={v} testId={testId ? `${testId}-chip-${v}` : undefined} style={{ display: 'flex', alignItems: 'center', height: 24, paddingLeft: 8, borderRadius: 7, backgroundColor: t.v('--color-background-elevated-secondary') }}>
            <Label color={t.text} size={12} lineHeight={16} weight={500} style={{ pointerEvents: 'none' }}>{itemToLabel(v)}</Label>
            <div
              testId={testId ? `${testId}-chip-remove-${v}` : undefined}
              role="button"
              aria-label="Remove"
              onClick={() => { if (!disabled) setValue(selectedList.filter((x) => x !== v)) }}
              style={{ display: 'flex', alignItems: 'center', height: 24, paddingLeft: 6, paddingRight: 6, opacity: 0.8, cursor: 'pointer', hover: { opacity: 1 } }}
            >
              <Icon source={N.x} size={14} color={t.text} style={{ pointerEvents: 'none' }} />
            </div>
          </div>
        ))}
        {inputField(true)}
        {popup}
      </div>
    )
  }

  return (
    <div
      ref={(el) => { fieldRef.current = el }}
      style={{
        display: 'flex',
        alignItems: 'center',
        position: 'relative',
        height: 32,
        ...(width ? { width } : { width: '100%' }),
        borderRadius: 10,
        borderWidth: 1,
        borderColor: focused ? ink(t, 0.3) : t.border,
        backgroundColor: t.variant === 'dark' ? t.inputGroupFill : t.v('--background'),
        opacity: disabled ? 0.64 : 1,
      }}
    >
      {inputField(false)}
      {showClear ? button('clear') : showTrigger ? button('trigger') : null}
      {popup}
    </div>
  )
}

function withAlpha(color: string, alpha: number) {
  const hex = color.match(/^#([0-9a-f]{6})$/i)
  if (hex) { const n = parseInt(hex[1]!, 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})` }
  const rgb = color.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) { const [r, g, b, a = '1'] = rgb[1]!.split(/[\s,/]+/).filter(Boolean); return `rgba(${r}, ${g}, ${b}, ${Number(a) * alpha})` }
  return color
}
