// Chip kind 1 of 2: the picker chip. A pill (28, `sm` 24) that opens a menu or filters a list: an optional lead (a glyph, a
// provider mark or a project dot), the label, optional secondary text and a chevron (omitted for a single-select filter).
// Replaces `FooterChip`, `TrayChip`, the Notes scope `Chip`, the Tasks quick-add scope chip, the model trigger, "Queue ⌄" and the
// dock empty-state chips. States: rest, hover, open (menu showing), selected (filter on), focus, disabled.
//
// `quiet` is the Tasks/Notes property picker (`.prop`, spec §2.2): transparent at rest with the chevron hidden; hover shows a
// neutral ink fill and the chevron. `neutral` keeps a selected chip in ink instead of the accent tint (Tasks and Notes keep
// their selection neutral; spec §5 would tint it).
import type { StyleDesc } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { SCALE } from '../motion/kit.tsx'
import { Chevron } from '../motion/Chevron.tsx'
import { pressTransform } from '../motion/press.ts'
import { N } from '../nav/glyphs.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { glyphSource } from './Button.tsx'
import { CONTROL, RADIUS, useControls } from './controls.ts'

export interface PickerChipProps {
  children?: ReactNode
  /** Lead glyph (a kit icon name or an SVG source). */
  icon?: string
  /** A provider mark (`claude-code`, `codex`, …) as the lead. */
  mark?: string
  /** A 7 px project dot as the lead. */
  dot?: string
  /** Any other lead. */
  lead?: ReactNode
  /** Dimmer text after the label (an effort, a count). */
  secondary?: string
  /** Show the chevron (default); a single-select filter hides it. */
  chevron?: boolean
  /** The menu is showing: the open fill, and the chevron turns. */
  open?: boolean
  /** The filter is on. */
  selected?: boolean
  neutral?: boolean
  quiet?: boolean
  size?: 'sm' | 'md'
  disabled?: boolean
  /** Let the chip shrink and its label truncate (a footer row that must fit); `maxWidth` caps it. */
  truncate?: boolean
  maxWidth?: number
  onClick?: () => void
  /** Called instead of `onClick` when Enter or Space activates the chip (keyboard-navigation flags). */
  onKeyboard?: () => void
  label?: string
  testId?: string
  style?: StyleDesc
}

export function PickerChip({ children, icon, mark, dot, lead, secondary, chevron = true, open = false, selected = false, neutral = false, quiet = false, size = 'md', disabled = false, truncate = false, maxWidth, onClick, onKeyboard, label, testId, style }: PickerChipProps) {
  const t = useTheme()
  const c = useControls()
  const g = CONTROL[size]
  const [hover, setHover] = useState(false)
  const lit = hover && !disabled
  const selectedBg = neutral || quiet ? c.ink(0.12) : c.chip.selBg
  const rest = selected ? selectedBg : open ? (quiet ? c.prop.hover : c.chip.open) : quiet ? 'rgba(0, 0, 0, 0)' : c.chip.bg
  const hoverBg = selected ? selectedBg : quiet ? c.prop.hover : c.chip.hover
  const fg = disabled ? c.disabled.fg : selected && !neutral && !quiet ? c.chip.selFg : lit || open || selected || quiet ? t.text : t.text
  const glyphColor = disabled ? c.disabled.fg : selected && !neutral && !quiet ? c.chip.selFg : lit ? t.text : t.iconSecondary
  const showChevron = chevron && (!quiet || lit || open)
  const hasLead = !!(icon || mark || dot || lead)
  const text = typeof children === 'string' ? <Label color={fg} size={g.font} lineHeight={g.line} weight={500} truncate={truncate || !!maxWidth}>{children}</Label> : children
  return (
    <div
      testId={testId}
      role="button"
      tabIndex={disabled || !onClick ? -1 : 0}
      aria-label={label ?? (typeof children === 'string' ? children : undefined)}
      aria-pressed={selected || undefined}
      aria-expanded={open || undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={onClick ? (e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) (onKeyboard ?? onClick)() } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      paintTransform={pressTransform(!disabled && !!onClick, SCALE.large)}
      style={{
        display: 'flex', alignItems: 'center', gap: size === 'sm' ? 5 : 6, height: g.height, ...(truncate ? { minWidth: 0, flexShrink: 1 } : { flexShrink: 0 }), ...(maxWidth ? { maxWidth, minWidth: 0 } : {}),
        paddingLeft: hasLead ? 8 : 10, paddingRight: chevron ? 7 : 10, borderRadius: RADIUS.pill, backgroundColor: rest, cursor: disabled ? 'default' : 'pointer',
        ...(disabled ? {} : { hover: { backgroundColor: hoverBg }, active: { backgroundColor: selected ? selectedBg : c.chip.open }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }),
        ...style,
      }}
    >
      {icon && <Icon source={glyphSource(icon)} size={size === 'sm' ? 13 : 14} color={glyphColor} style={{ pointerEvents: 'none' }} />}
      {mark && <ProviderMark kind={mark} size={size === 'sm' ? 12 : 14} />}
      {dot && <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: dot, flexShrink: 0, pointerEvents: 'none' }} />}
      {lead}
      {text}
      {secondary && <Label color={disabled ? c.disabled.fg : t.textTertiary} size={g.font} lineHeight={g.line} weight={500} truncate={truncate || !!maxWidth}>{secondary}</Label>}
      {chevron && (
        <div style={{ display: 'flex', width: 11, height: 11, flexShrink: 0, opacity: showChevron ? 1 : 0, pointerEvents: 'none' }}>
          <Chevron open={open} source={N.chevronDown} turn={180} duration={0.25} size={11} color={lit || open ? t.iconSecondary : t.textTertiary} />
        </div>
      )}
    </div>
  )
}
