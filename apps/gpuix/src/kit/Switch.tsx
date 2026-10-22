// The desktop's `Switch` (`components/kit/switch.tsx`, Base UI): a 32×20 track with a 1px border and 1px padding,
// accent when on and ink 20% over the opaque control fill when off, and a white 16px thumb that travels 12px
// (`translate .2s ease-out`). Holding the pointer stretches the thumb 10% toward the track's centre after 100 ms
// (`scale .1s .1s`). The track colour cross-fades over 200 ms (`transition-[background-color,border-color] duration-200`).
// Like the desktop, none of this is guarded by Reduce Motion, and keyboard toggles slide the same way.
//
// Also exports the focus ring every kit control shares (`useFocusRing`, `FocusRing`): Tailwind's
// `focus-visible:ring-N ring-offset-M`, drawn outside the control's box and shown only for keyboard focus.
import { motion, type StyleDesc } from '@gpuix/react'
import { useRef, useState } from 'react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { over } from '../theme.ts'
import { useTheme } from '../ui.tsx'

/** CSS `ease-out` (the keyword, not the `--ease-out` token). */
const CSS_EASE_OUT: [number, number, number, number] = [0, 0, 0.58, 1]
/** CSS `ease`. */
const CSS_EASE: [number, number, number, number] = [0.25, 0.1, 0.25, 1]
/** Tailwind's default transition curve. */
export const TW_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1]

/**
 * `:focus-visible` for a GPUIX control: focus that did not come from a pointer press. Spread `handlers` on the
 * focusable element; `visible` is true while keyboard focus is on it.
 */
export function useFocusRing() {
  const [visible, setVisible] = useState(false)
  const pointer = useRef(0)
  return {
    visible,
    handlers: {
      onMouseDown: () => { pointer.current = Date.now() },
      onFocus: () => setVisible(Date.now() - pointer.current > 150),
      onBlur: () => setVisible(false),
    },
    /** A key press on a pointer-focused control turns the ring on, as browsers do. */
    keyed: () => setVisible(true),
  }
}

/**
 * `ring-{width} ring-offset-{offset}`: a `width`-px band starting `offset` px outside the box, the gap painted in
 * `offsetColor` (`ring-offset-background`). `radius` is the control's own corner radius. The parent must be
 * `position: relative` and must not clip.
 */
export function FocusRing({ visible, radius, color, width = 2, offset = 1, offsetColor }: { visible: boolean; radius: number; color: string; width?: number; offset?: number; offsetColor?: string }) {
  if (!visible) return null
  const outer = width + offset
  const base: StyleDesc = { position: 'absolute', pointerEvents: 'none' }
  return <>
    {offset > 0 && offsetColor && <div style={{ ...base, left: -offset, top: -offset, right: -offset, bottom: -offset, borderWidth: offset, borderColor: offsetColor, borderRadius: radius + offset }} />}
    <div style={{ ...base, left: -outer, top: -outer, right: -outer, bottom: -outer, borderWidth: width, borderColor: color, borderRadius: radius + outer }} />
  </>
}

/** `color` at `alpha` × its own alpha, like Tailwind's `ring-[color]/60`. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim()
  if (c.startsWith('#')) {
    const h = c.slice(1)
    const full = h.length <= 4 ? [...h].map((x) => x + x).join('') : h
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
    return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${Number(((full.length === 8 ? n(6) / 255 : 1) * alpha).toFixed(3))})`
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/)
  if (!m) return c
  const [r, g, b, a = 1] = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number)
  return `rgba(${r}, ${g}, ${b}, ${Number((a! * alpha).toFixed(3))})`
}

/**
 * `opacity: .64` on a whole control, as the desktop's `data-disabled:opacity-64` composites it: one layer, so
 * overlapping parts do not show through each other. GPUIX applies opacity per element, so disabled controls paint
 * their colours pre-composited over `under` (the colour beneath, opaque) and onto `surface` (the page) instead.
 */
export function dim(color: string, surface: string, under?: string, alpha = 0.64, glass = false): string {
  // Whole-window glass has no page colour to flatten onto: keep the translucency instead of painting an opaque slab.
  if (glass) return withAlpha(under ? over(color, under) : color, alpha)
  return over(withAlpha(under ? over(color, under) : color, alpha), surface)
}

/** A value that is controlled when `value` is set, else kept here from `initial`. */
export function useControllable<T>(value: T | undefined, initial: T, onChange?: (next: T) => void): [T, (next: T) => void] {
  const [own, setOwn] = useState(initial)
  const current = value === undefined ? own : value
  return [current, (next: T) => { if (value === undefined) setOwn(next); onChange?.(next) }]
}

export interface SwitchProps {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  'aria-label'?: string
  testId?: string
  style?: StyleDesc
}

export function Switch({ checked: checkedProp, defaultChecked = false, onCheckedChange, disabled = false, 'aria-label': label, testId, style }: SwitchProps) {
  const t = useTheme()
  const [checked, setChecked] = useControllable(checkedProp, defaultChecked, onCheckedChange)
  const [pressed, setPressed] = useState(false)
  const focus = useFocusRing()
  // `scale-x-110` about the thumb's left edge when off, its right edge when on.
  const grow = pressed && !disabled ? 1.6 : 0
  const toggle = () => { if (!disabled) setChecked(!checked) }
  // Disabled: colours flattened onto the page instead of a per-element opacity (see `dim`).
  const page = t.v('--background')
  const d = (c: string, under?: string) => (disabled ? dim(c, page, under, undefined, t.scope === 'window') : c)
  const track = checked ? t.switchOn : t.switchOff
  const thumb = <div style={{ flexGrow: 1, height: 16, borderRadius: 8, backgroundColor: d('#ffffff'), boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 3 / 2, spreadRadius: 0, color: `rgba(0, 0, 0, ${disabled ? 0.064 : 0.1})` }, pointerEvents: 'none' }} />
  const layer: StyleDesc = { position: 'absolute', left: 0, top: 0, width: 32, height: 20, borderRadius: 10, borderWidth: 1, pointerEvents: 'none' }
  return (
    <div
      testId={testId}
      role="switch"
      aria-label={label}
      aria-checked={checked}
      tabIndex={disabled ? -1 : 0}
      onMouseDown={() => { focus.handlers.onMouseDown(); if (!disabled) setPressed(true) }}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onFocus={focus.handlers.onFocus}
      onBlur={focus.handlers.onBlur}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') { focus.keyed(); toggle() } }}
      style={{ position: 'relative', width: 32, height: 20, flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer', ...style }}
    >
      <div style={{ ...layer, borderColor: d(t.switchOffBorder, t.switchOff), backgroundColor: d(t.switchOff) }} />
      {PATCHED_NATIVE
        ? <div paintTransform={{ initial: false, animate: { opacity: checked ? 1 : 0 }, transition: { duration: 0.2, ease: TW_EASE } }} style={{ ...layer, borderColor: d(t.switchOn), backgroundColor: d(t.switchOn) }} />
        : <motion.div initial={false} animate={{ opacity: checked ? 1 : 0 }} transition={{ duration: 0.2, ease: TW_EASE }} style={{ ...layer, borderColor: d(t.switchOn), backgroundColor: d(t.switchOn) }} />}
      {/* Travel and stretch run on their own curves, so they sit on two nested layers: the travel is a paint-only translation of
          the whole thumb, the held stretch the desktop's `scale-x-110` itself (N5), both with no layout per frame. */}
      {PATCHED_NATIVE
        ? <div paintTransform={{ initial: false, animate: { translateX: checked ? 12 : 0 }, transition: { duration: 0.2, ease: CSS_EASE_OUT } }} style={{ position: 'absolute', left: 1, top: 1, width: 18, height: 18, pointerEvents: 'none' }}>
          <div
            paintTransform={{ initial: false, animate: { scaleX: pressed && !disabled ? 1.1 : 1 }, transition: { duration: 0.1, delay: 0.1, ease: [...CSS_EASE] }, origin: [checked ? 1 : 0, 0.5] }}
            // `ring-1 ring-black/5` around the 16px thumb, then the thumb with `shadow-sm`.
            style={{ position: 'absolute', top: 0, left: 0, width: 18, height: 18, borderRadius: 9, backgroundColor: disabled ? d('rgba(0, 0, 0, 0.05)', track) : 'rgba(0, 0, 0, 0.05)', pointerEvents: 'none', display: 'flex', paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1 }}
          >
            {thumb}
          </div>
        </div>
        : <motion.div initial={false} animate={{ left: checked ? 13 : 1 }} transition={{ duration: 0.2, ease: CSS_EASE_OUT }} style={{ position: 'absolute', top: 1, width: 18, height: 18, pointerEvents: 'none' }}>
          <motion.div
            initial={false}
            animate={{ left: checked ? -grow : 0, width: 18 + grow }}
            transition={{ duration: 0.1, delay: 0.1, ease: CSS_EASE }}
            style={{ position: 'absolute', top: 0, height: 18, borderRadius: 9, backgroundColor: disabled ? d('rgba(0, 0, 0, 0.05)', track) : 'rgba(0, 0, 0, 0.05)', pointerEvents: 'none', display: 'flex', paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1 }}
          >
            {thumb}
          </motion.div>
        </motion.div>}
      <FocusRing visible={focus.visible} radius={10} color={withAlpha(t.v('--color-border-focus'), 0.6)} offsetColor={t.v('--background')} />
    </div>
  )
}
