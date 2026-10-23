// The one button (ADE-55, Direction C "Tinted state"; `kit/controls.ts` holds the tokens). It replaces the five Buttons the app
// grew (transcript, settings, usage, `KitButton`, `EnvButton`) and the one-off pills.
//
// Variants: `primary` is the one commit action of a surface (accent tint, 600 label), `secondary` the real alternative (ink
// fill), `ghost` the lowest weight (no fill until hover), `destructive` a confirm that removes something. `danger` turns a
// secondary or ghost label red (the macOS "Don't Save" placement). One primary per surface (spec §1.4).
//
// States are native where they can be: `hover`, `active` (pressed) and `focusVisible` (a 2 px accent ring, keyboard focus only)
// paint with no React state. The ghost label also lights on hover, which a native hover cannot do to a child, so a ghost tracks
// the pointer itself. A disabled button drops to the disabled fill and label, loses its shadow and never reacts: it no longer
// looks like the primary. `busy` keeps the label, leads it with a 12 px spinner and is disabled.
import type { StyleDesc } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { Icon, ICONS, type IconName } from '../icons.tsx'
import { SCALE, SwapOnChange } from '../motion/kit.tsx'
import { pressTransform } from '../motion/press.ts'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'
import { CONTROL, useControls, type ControlSize } from './controls.ts'
import { Spinner } from './Spinner.tsx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'

/** A glyph by kit name or raw SVG `source`. */
export const glyphSource = (icon: string) => (icon in ICONS ? ICONS[icon as IconName] : icon)

export interface ButtonProps {
  children?: ReactNode
  variant?: ButtonVariant
  /** Red label on a secondary or ghost button. */
  danger?: boolean
  size?: ControlSize
  /** Leading glyph (a kit icon name or an SVG source). */
  icon?: string
  /** Trailing glyph. */
  iconAfter?: string
  /** A menu trigger: a trailing 12 px chevron (`open` turns it, as `PickerChip` does not need to). */
  chevron?: boolean
  /** A shortcut hint after the label, in the label's colour at 55% (`⌘↵`). The primary owns ⌘↵. */
  kbd?: string
  busy?: boolean
  disabled?: boolean
  onClick?: () => void
  /** Called on Enter/Space before `onClick` (keyboard-navigation flags such as `keyboardAnswer`). */
  onKeyboard?: () => void
  /** Accessible name; defaults to a string child. */
  label?: string
  /** A label that reports state ("Send" → "Sending…"): the old text leaves while the new one rises in. */
  swap?: boolean
  /** After the label, before the chevron (a rotating `Chevron`). */
  trailing?: ReactNode
  /** Full width; a full-width button never squashes. */
  block?: boolean
  testId?: string
  style?: StyleDesc
}

export function Button({ children, variant = 'secondary', danger = false, size = 'md', icon, iconAfter, chevron = false, kbd, busy = false, disabled = false, onClick, onKeyboard, label, swap = false, trailing, block = false, testId, style }: ButtonProps) {
  const t = useTheme()
  const c = useControls()
  const g = CONTROL[size]
  const [hover, setHover] = useState(false)
  const off = disabled || busy
  const filled = variant !== 'ghost'
  const v = variant === 'primary' ? c.primary : variant === 'destructive' ? c.destructive : variant === 'secondary' ? c.secondary : null
  const fg = off ? c.disabled.fg
    : variant === 'primary' ? c.primary.fg
    : variant === 'destructive' ? c.destructive.fg
    : danger ? c.danger
    : variant === 'ghost' ? (hover ? t.text : c.ghost.fg)
    : c.secondary.fg
  const rest = off ? (filled ? c.disabled.bg : 'rgba(0, 0, 0, 0)') : v ? v.bg : 'rgba(0, 0, 0, 0)'
  const run = () => { if (!off) onClick?.() }
  const hasIcon = !!icon || busy
  const hasAfter = !!iconAfter || chevron || !!trailing
  const weight = variant === 'primary' || variant === 'destructive' ? 600 : 500
  const labelNode = typeof children === 'string' || typeof children === 'number'
    ? swap && typeof children === 'string'
      ? <SwapOnChange active={children}><Label color={fg} size={g.font} lineHeight={g.line} weight={weight} style={{ whiteSpace: 'nowrap' }}>{children}</Label></SwapOnChange>
      : <Label color={fg} size={g.font} lineHeight={g.line} weight={weight} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>{children}</Label>
    : children
  const only = children == null && !kbd
  return (
    <div
      testId={testId}
      role="button"
      tabIndex={off || !onClick ? -1 : 0}
      aria-label={label ?? (typeof children === 'string' ? children : undefined)}
      aria-disabled={off || undefined}
      onClick={onClick ? run : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'enter' || e.key === 'space') { onKeyboard?.(); run() } } : undefined}
      onMouseEnter={variant === 'ghost' ? () => setHover(true) : undefined}
      onMouseLeave={variant === 'ghost' ? () => setHover(false) : undefined}
      paintTransform={pressTransform(!off && !!onClick && !block, SCALE.press)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: g.gap, flexShrink: 0,
        height: g.height, minWidth: only ? g.height : 0, ...(block ? { width: '100%' } : {}),
        paddingLeft: only ? 0 : hasIcon ? g.iconPad : g.padX, paddingRight: only ? 0 : hasAfter ? g.padX - 3 : g.padX,
        borderRadius: g.radius, backgroundColor: rest, cursor: off ? 'default' : 'pointer',
        ...(off ? {} : {
          hover: { backgroundColor: variant === 'ghost' ? c.ghost.hover : v!.hover },
          active: { backgroundColor: variant === 'ghost' ? c.ghost.press : v!.press },
          focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 },
        }),
        ...style,
      }}
    >
      {busy ? <Spinner size={12} color={fg} /> : icon ? <Icon source={glyphSource(icon)} size={g.glyph} color={fg} style={{ pointerEvents: 'none' }} /> : null}
      {labelNode}
      {kbd && <Label color={fg} size={g.font - 1} lineHeight={g.line} weight={500} style={{ opacity: 0.55, marginLeft: 2, pointerEvents: 'none' }}>{kbd}</Label>}
      {trailing}
      {iconAfter && <Icon source={glyphSource(iconAfter)} size={13} color={fg} style={{ opacity: 0.7, pointerEvents: 'none' }} />}
      {chevron && <Icon source={N.chevronDown} size={12} color={fg} style={{ opacity: 0.7, pointerEvents: 'none' }} />}
    </div>
  )
}
