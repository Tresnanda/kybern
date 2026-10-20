// The desktop's `Toggle` (`components/kit/toggle.tsx`, Base UI): a two-state button. Sizes xs 24 / sm 28 /
// default 32 / lg 36 px tall (`sm:` heights; the window is always wider than 640 px), square minimum, radius 6 (xs)
// or 10, 14 px medium text, 16 px glyphs at 80% (14 px on xs). `default` is borderless; `outline` has the
// `--color-border` hairline on the opaque control fill. Hover fills `--color-background-button-secondary-hover`,
// the pressed (on) state `--color-background-button-secondary`; fills cross-fade over 150 ms `--ease-out` and the
// whole control squashes to 97% while held (80 ms in, 150 ms out; `styles/motion.css` press feedback, painted natively
// by `motion/press.ts`). Reduce Motion keeps the colour fades and drops the squash. There is no toggle group in the
// desktop kit.
//
// Also exports `Fill`, the eased hover/press fill other kit buttons reuse.
import { motion, type StyleDesc } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { DURATION, EASE } from '../motion/kit.tsx'
import { pressTransform } from '../motion/press.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Label, useTheme } from '../ui.tsx'
import { FocusRing, useControllable, useFocusRing } from './Switch.tsx'

const OUT = [...EASE.out] as [number, number, number, number]

/** One colour layer that fades in while `on` (150 ms `--ease-out`, the kit's `transition-colors`). */
export function Fill({ on, color, radius, inset = 0 }: { on: boolean; color: string; radius: number; inset?: number }) {
  const style = { position: 'absolute', left: inset, top: inset, right: inset, bottom: inset, borderRadius: radius, backgroundColor: color, pointerEvents: 'none' } as const
  // An opacity change on a fill: a paint-only fade (no layout or render per frame) where the addon has it.
  if (PATCHED_NATIVE) return <div paintTransform={{ initial: false, animate: { opacity: on ? 1 : 0 }, transition: { duration: DURATION.quick, ease: OUT } }} style={style} />
  return <motion.div initial={false} animate={{ opacity: on ? 1 : 0 }} transition={{ duration: DURATION.quick, ease: OUT }} style={style} />
}

export const TOGGLE_SIZE = {
  xs: { height: 24, padX: 3, radius: 6, glyph: 14 },
  sm: { height: 28, padX: 5, radius: 10, glyph: 16 },
  default: { height: 32, padX: 7, radius: 10, glyph: 16 },
  lg: { height: 36, padX: 9, radius: 10, glyph: 16 },
} as const

export interface ToggleProps {
  pressed?: boolean
  defaultPressed?: boolean
  onPressedChange?: (pressed: boolean) => void
  variant?: 'default' | 'outline'
  size?: keyof typeof TOGGLE_SIZE
  disabled?: boolean
  /** Text label (14 px medium). */
  children?: ReactNode
  /** Leading glyph source (`N.*`), drawn at 80% like `[&_svg]:opacity-80`. */
  icon?: string
  'aria-label'?: string
  testId?: string
  style?: StyleDesc
}

export function Toggle({ pressed: pressedProp, defaultPressed = false, onPressedChange, variant = 'default', size = 'default', disabled = false, children, icon, 'aria-label': label, testId, style }: ToggleProps) {
  const t = useTheme()
  const [on, setOn] = useControllable(pressedProp, defaultPressed, onPressedChange)
  const [hover, setHover] = useState(false)
  const focus = useFocusRing()
  const g = TOGGLE_SIZE[size]
  const outline = variant === 'outline'
  const toggle = () => { if (!disabled) setOn(!on) }
  // `data-pressed` wins over `hover`, both over the outline's opaque fill.
  const state = on ? 'on' : hover && !disabled ? 'hover' : 'rest'
  const text = typeof children === 'string' ? <Label color={t.text} size={14} lineHeight={20} weight={500} style={{ pointerEvents: 'none' }}>{children}</Label> : children
  return (
    <div
      testId={testId}
      role="button"
      aria-label={label ?? (typeof children === 'string' ? children : undefined)}
      aria-selected={on}
      tabIndex={disabled ? -1 : 0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={focus.handlers.onMouseDown}
      onFocus={focus.handlers.onFocus}
      onBlur={focus.handlers.onBlur}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { focus.keyed(); toggle() } }}
      paintTransform={pressTransform(!disabled)}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: icon && text ? 6 : 8, flexShrink: 0, height: g.height, minWidth: g.height, paddingLeft: g.padX + 1 - (icon && text ? 2 : 0), paddingRight: g.padX + 1, opacity: disabled ? 0.64 : 1, cursor: disabled ? 'default' : 'pointer', ...style }}
    >
      <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none', borderRadius: g.radius }}>
        {outline && <Fill on={state === 'rest'} color={t.v('--color-background-control-opaque')} radius={g.radius} />}
        <Fill on={state === 'hover'} color={t.v('--color-background-button-secondary-hover')} radius={g.radius} />
        <Fill on={state === 'on'} color={t.v('--color-background-button-secondary')} radius={g.radius} />
        {outline && <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: g.radius, borderWidth: 1, borderColor: t.v('--color-border'), pointerEvents: 'none' }} />}
      </div>
      {/* `[&_svg]:-mx-0.5`, folded into the padding and gap (negative margins collapse GPUIX's intrinsic width). */}
      {icon && <svg source={icon} style={{ width: g.glyph, height: g.glyph, flexShrink: 0, color: t.text, opacity: 0.8, pointerEvents: 'none' }} />}
      {text}
      <FocusRing visible={focus.visible} radius={g.radius} color={t.v('--ring')} offsetColor={t.v('--background')} />
    </div>
  )
}
