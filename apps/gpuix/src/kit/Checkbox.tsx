// The one checkbox (ADE-55, Direction C): a 16 px box, radius 5. Off is a 1.5 px ink ring on no fill (hover: the ring darkens);
// on is the accent with a white tick. Checking fills the box (opacity 0 → 1 and scale 0.8 → 1, 150 ms smooth-out), then the
// check strokes itself in (`.t-check-path`: dasharray 24, dashoffset 24 → 0 over 250 ms smooth-out after an 80 ms delay).
// Unchecking is instant. `indeterminate` is the accent box with a white dash. Replaces the Tasks `Check`, the criteria box, the
// worktree and close-guard boxes and the coordinator card glyphs. Keyboard focus draws the 2 px accent ring natively.
//
// The draw is native and paint-only (`strokeDraw`, `motion/success.ts`; `native/patches/stroke_draw.rs`): the check's sprite
// shows the SVG rasterized at each presented frame's dash offset, with no render or layout per frame. With the stock
// addon the check appears whole.
// Reduce Motion: no fill transition and no draw (`motion-reduce:transition-none`, `.t-check-path { animation: none }`).
import { motion, type StyleDesc } from '@gpuix/react'
import { useState } from 'react'
import { DURATION, EASE } from '../motion/kit.tsx'
import { strokeDraw } from '../motion/success.ts'

import { REDUCED_MOTION, useTheme } from '../ui.tsx'
import { dim, useControllable, useFocusRing, withAlpha } from './Switch.tsx'
import { RADIUS, useControls } from './controls.ts'

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="3">${body}</svg>`
const CHECK = svg('<path d="M5.252 12.7 10.2 18.63 18.748 5.37"/>')
const DASH = svg('<path d="M5.252 12h13.496"/>')

export interface CheckboxProps {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  /** Shows a dash instead of the check, on the unfilled box (Base UI `indeterminate`). */
  indeterminate?: boolean
  disabled?: boolean
  /** `aria-invalid`: destructive border and focus ring. */
  invalid?: boolean
  'aria-label'?: string
  testId?: string
  style?: StyleDesc
}

export function Checkbox({ checked: checkedProp, defaultChecked = false, onCheckedChange, indeterminate = false, disabled = false, invalid = false, 'aria-label': label, testId, style }: CheckboxProps) {
  const t = useTheme()
  const c = useControls()
  const [checked, setChecked] = useControllable(checkedProp, defaultChecked, onCheckedChange)
  const focus = useFocusRing()
  // Only a change made while mounted animates; a box that starts checked shows its check at rest.
  const [animate, setAnimate] = useState(false)
  const toggle = () => { if (disabled) return; setAnimate(!REDUCED_MOTION); setChecked(indeterminate ? true : !checked) }
  const shown = checked || indeterminate
  const filled = shown
  const destructive = t.v('--destructive')
  const edge = invalid ? withAlpha(destructive, focus.visible ? 0.9 : 0.7) : c.check.edge
  // Disabled: colours flattened onto the page instead of a per-element opacity (see `dim` in Switch.tsx).
  const page = t.v('--background')
  const glass = t.scope === 'window'
  const d = (color: string, under?: string) => (disabled ? dim(color, page, under, 0.4, glass) : color)
  const primary = d(c.check.on)
  const play = animate && !REDUCED_MOTION
  // `.t-check-path`: dasharray 24, drawn over `--duration-fast` after `--duration-micro`.
  const draw = play ? strokeDraw(24, DURATION.micro * 1000) : undefined
  const tween = { duration: DURATION.quick, ease: [...EASE.smoothOut] as [number, number, number, number] }
  const box: StyleDesc = { position: 'absolute', pointerEvents: 'none' }
  return (
    <div
      testId={testId}
      role="checkbox"
      aria-label={label}
      aria-checked={indeterminate ? undefined : checked}
      aria-valuetext={indeterminate ? 'mixed' : undefined}
      tabIndex={disabled ? -1 : 0}
      onMouseDown={focus.handlers.onMouseDown}
      onFocus={focus.handlers.onFocus}
      onBlur={focus.handlers.onBlur}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === 'space') { focus.keyed(); toggle() } }}
      style={{ position: 'relative', width: 16, height: 16, flexShrink: 0, borderRadius: RADIUS.check, borderWidth: 1.5, borderColor: filled ? 'rgba(0, 0, 0, 0)' : d(edge), cursor: disabled ? 'default' : 'pointer', ...(disabled ? {} : { hover: filled ? {} : { borderColor: invalid ? edge : c.check.hoverEdge }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }), ...style }}
    >
      {shown && (
        // `-inset-px`: the indicator covers the border box; it grows from 80% about its centre.
        <motion.div
          key={`${filled}`}
          initial={play ? { opacity: 0, left: 0.1, top: 0.1, width: 12.8, height: 12.8, borderRadius: 4 } : false}
          animate={{ opacity: 1, left: -1.5, top: -1.5, width: 16, height: 16, borderRadius: RADIUS.check }}
          transition={tween}
          style={{ ...box, backgroundColor: primary }}
        />
      )}
      {shown && (
        <motion.div key={`g${filled}`} initial={play ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={tween} style={{ ...box, left: 0.5, top: 0.5, width: 12, height: 12 }}>
          {indeterminate
            ? <svg source={DASH} style={{ ...box, left: 0, top: 0, width: 12, height: 12, color: d(c.check.tick, primary) }} />
            : <svg source={CHECK} {...(draw ? { paintAnimation: draw } : {})} style={{ ...box, left: 0, top: 0, width: 12, height: 12, color: d(c.check.tick, primary) }} />}
        </motion.div>
      )}
    </div>
  )
}
