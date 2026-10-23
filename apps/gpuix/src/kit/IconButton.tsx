// The one icon button: a square at the control height (24 / 28 / 32), ghost by default. Rest glyph `icon2`, hover and press
// `text`; `active` is the toggled or current state (the accent tint); `secondary` is the filled square. Replaces
// `sidebar/rows.tsx` IconButton, `nav/TitleBar` ChromeIcon, `notes/EditorBar` IconButton, the terminal toolbar buttons,
// Tasks `AddButton`, `ChromeButton` and `Toggle`'s icon form. The hit area is never under 24.
import type { StyleDesc } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { Icon } from '../icons.tsx'
import { SCALE } from '../motion/kit.tsx'
import { pressTransform } from '../motion/press.ts'
import { useTheme } from '../ui.tsx'
import { glyphSource } from './Button.tsx'
import { CONTROL, useControls, type ControlSize } from './controls.ts'

export interface IconButtonProps {
  /** Glyph: a kit icon name or an SVG source. */
  icon: string
  /** Accessible name (required: there is no text). */
  label: string
  size?: ControlSize
  /** The toggled or current state. */
  active?: boolean
  /** The filled square instead of the ghost. */
  secondary?: boolean
  disabled?: boolean
  onClick?: () => void
  /** Called on Enter/Space before `onClick` (keyboard-navigation flags), like `Button`. */
  onKeyboard?: () => void
  /** Glyph size; defaults to 14 at `sm` and 16 above. */
  glyph?: number
  /** Overrides the rest glyph colour (a status colour). */
  color?: string
  /** Replaces the glyph (a spinner, or a glyph that swaps on change); `icon` is then unused. */
  children?: ReactNode
  /** Focus reporters (a row that keeps its actions showing while one is focused). */
  onFocus?: () => void
  onBlur?: () => void
  /** Pointer reporters, composed with the button's own hover (a `Tip` around the button passes its trigger handlers here). */
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  onMouseDown?: () => void
  /** Overrides the focus stop (-1 inside a trigger that is the stop itself, a `Menu`'s). */
  tabIndex?: number
  testId?: string
  style?: StyleDesc
}

export function IconButton({ icon, label, size = 'md', active = false, secondary = false, disabled = false, onClick, onKeyboard, glyph, color, children, onFocus, onBlur, onMouseEnter, onMouseLeave, onMouseDown, tabIndex, testId, style }: IconButtonProps) {
  const t = useTheme()
  const c = useControls()
  const g = CONTROL[size]
  const [hover, setHover] = useState(false)
  const lit = (hover || false) && !disabled
  const fg = disabled ? c.disabled.fg : active ? c.iconButton.activeFg : color ? color : lit || secondary ? t.text : t.iconSecondary
  const rest = active ? c.iconButton.activeBg : secondary ? c.secondary.bg : 'rgba(0, 0, 0, 0)'
  return (
    <div
      testId={testId}
      role="button"
      tabIndex={tabIndex ?? (disabled || !onClick ? -1 : 0)}
      aria-label={label}
      aria-pressed={active || undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={onClick ? (e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) { onKeyboard?.(); onClick() } } : undefined}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={() => { setHover(true); onMouseEnter?.() }}
      onMouseLeave={() => { setHover(false); onMouseLeave?.() }}
      onMouseDown={onMouseDown}
      paintTransform={pressTransform(!disabled && !!onClick, SCALE.large)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        width: g.height, height: g.height, borderRadius: g.radius, backgroundColor: rest,
        cursor: disabled ? 'default' : 'pointer',
        ...(disabled ? {} : {
          hover: { backgroundColor: active ? c.iconButton.activeBg : secondary ? c.secondary.hover : c.ghost.hover },
          active: { backgroundColor: active ? c.iconButton.activeBg : secondary ? c.secondary.press : c.ghost.press },
          focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 },
        }),
        ...style,
      }}
    >
      {children ?? <Icon source={glyphSource(icon)} size={glyph ?? g.iconOnly} color={fg} style={{ pointerEvents: 'none' }} />}
    </div>
  )
}
