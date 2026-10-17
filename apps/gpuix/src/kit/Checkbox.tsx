// The desktop's `Checkbox` (`components/kit/checkbox.tsx`, Base UI): a 16px box (radius 4, `--color-border-light`
// border; `--input`/32 fill in dark, `--background` otherwise). Checking it fills the box with `--primary` (opacity
// 0 → 1 and scale 0.8 → 1, 150 ms smooth-out), then the check strokes itself in: `.t-check-path` dasharray 24,
// dashoffset 24 → 0 over 250 ms smooth-out after an 80 ms delay (`styles/motion.css`). Unchecking is instant.
// `indeterminate` shows a foreground dash on the unfilled box.
//
// GPUIX cannot tween `stroke-dashoffset`, so the draw is a sprite sequence: the check rendered at the dash offset of
// each 1/120 s of the curve, each frame shown for its slot by native opacity tweens (an outer one turns it on at
// its time, an inner one off at the next). The frames are exact SVG renders of the desktop's dash, with its round
// caps, and no JS runs while it plays. After the last frame they collapse into one still glyph.
// Reduce Motion: no fill transition and no draw (`motion-reduce:transition-none`, `.t-check-path { animation: none }`).
import { motion, type StyleDesc } from '@gpuix/react'
import { useState } from 'react'
import { DURATION, EASE } from '../motion/kit.tsx'
import { over } from '../theme.ts'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'
import { dim, FocusRing, useControllable, useFocusRing, withAlpha } from './Switch.tsx'

const CHECK_PATH = 'M5.252 12.7 10.2 18.63 18.748 5.37'
const DASH_PATH = 'M5.252 12h13.496'
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="3">${body}</svg>`
const checkAt = (offset: number) => svg(`<path d="${CHECK_PATH}" stroke-dasharray="24" stroke-dashoffset="${offset.toFixed(3)}"/>`)
const CHECK = svg(`<path d="${CHECK_PATH}"/>`)
const DASH = svg(`<path d="${DASH_PATH}"/>`)

/** `cubic-bezier(x1, y1, x2, y2)` at time fraction `x`. */
export function cubicBezier([x1, y1, x2, y2]: readonly [number, number, number, number], x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bx = (u: number) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u ** 2 * (1 - u) + u ** 3
  const by = (u: number) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u ** 2 * (1 - u) + u ** 3
  let lo = 0, hi = 1
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (bx(mid) < x) lo = mid; else hi = mid }
  return by((lo + hi) / 2)
}

/** Draw timing (`t-check-draw var(--duration-fast) var(--ease-smooth-out) var(--duration-micro)`). */
export const CHECK_DRAW = { delayMs: DURATION.micro * 1000, durationMs: DURATION.fast * 1000, slots: 30 } as const
const SLOT_MS = CHECK_DRAW.durationMs / CHECK_DRAW.slots
/** Dash offset shown in slot `k` (0 … slots): the curve sampled at the slot's start; the last slot is drawn. */
const FRAMES = Array.from({ length: CHECK_DRAW.slots + 1 }, (_, k) => checkAt(24 * (1 - cubicBezier(EASE.smoothOut, k / CHECK_DRAW.slots))))
const INSTANT = 0.001

/** One sprite frame: on at `onMs`, off at `offMs` (null: stays on). */
function Frame({ source, onMs, offMs, color, size }: { source: string; onMs: number; offMs: number | null; color: string; size: number }) {
  const box: StyleDesc = { position: 'absolute', left: 0, top: 0, width: size, height: size, pointerEvents: 'none' }
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: INSTANT, delay: onMs / 1000, ease: 'linear' }} style={box}>
      {offMs == null
        ? <svg source={source} style={{ ...box, color }} />
        : <motion.div initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: INSTANT, delay: offMs / 1000, ease: 'linear' }} style={box}><svg source={source} style={{ ...box, color }} /></motion.div>}
    </motion.div>
  )
}

/** The check stroking itself in, starting when it mounts. */
function DrawnCheck({ color, size }: { color: string; size: number }) {
  const [done, setDone] = useState(false)
  const last = CHECK_DRAW.delayMs + CHECK_DRAW.durationMs
  if (done) return <svg source={CHECK} style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, color, pointerEvents: 'none' }} />
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, pointerEvents: 'none' }}>
      {/* The delay shows the zero-length dash, like the desktop's `stroke-dashoffset: 24` before the animation starts. */}
      <Frame source={FRAMES[0]!} onMs={0} offMs={CHECK_DRAW.delayMs} color={color} size={size} />
      {FRAMES.map((source, k) => <Frame key={k} source={source} onMs={CHECK_DRAW.delayMs + k * SLOT_MS} offMs={k === CHECK_DRAW.slots ? null : CHECK_DRAW.delayMs + (k + 1) * SLOT_MS} color={color} size={size} />)}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: INSTANT, delay: last / 1000 + 0.05, ease: 'linear' }}
        // Collapse the sprite into one still glyph once the native clock has passed the last frame (one commit, after).
        onMotionComplete={() => setDone(true)}
        style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, pointerEvents: 'none' }}
      />
    </div>
  )
}

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
  const [checked, setChecked] = useControllable(checkedProp, defaultChecked, onCheckedChange)
  const focus = useFocusRing()
  // Only a change made while mounted animates; a box that starts checked shows its check at rest.
  const [animate, setAnimate] = useState(false)
  const toggle = () => { if (disabled) return; setAnimate(!REDUCED_MOTION); setChecked(indeterminate ? true : !checked) }
  const filled = checked && !indeterminate
  const shown = checked || indeterminate
  const dark = t.variant === 'dark'
  const destructive = t.v('--destructive')
  const fill = filled || !dark ? t.v('--background') : withAlpha(t.v('--input'), 0.32)
  const border = invalid ? withAlpha(destructive, focus.visible ? 0.64 : 0.36) : t.v('--color-border-light')
  const ring = invalid ? withAlpha(destructive, dark ? 0.24 : 0.48) : t.v('--ring')
  // Disabled: colours flattened onto the page instead of a per-element opacity (see `dim` in Switch.tsx).
  const page = t.v('--background')
  const boxFill = over(fill, page)
  const d = (c: string, under?: string) => (disabled ? dim(c, page, under) : c)
  const primary = d(t.v('--primary'))
  const play = animate && !REDUCED_MOTION
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
      style={{ position: 'relative', width: 16, height: 16, flexShrink: 0, borderRadius: 4, borderWidth: 1, borderColor: d(border, boxFill), backgroundColor: disabled ? d(boxFill) : fill, cursor: disabled ? 'default' : 'pointer', ...style }}
    >
      {shown && (
        // `-inset-px`: the indicator covers the border box; it grows from 80% about its centre.
        <motion.div
          key={`${filled}`}
          initial={play ? { opacity: 0, left: 0.6, top: 0.6, width: 12.8, height: 12.8, borderRadius: 3.2 } : false}
          animate={{ opacity: 1, left: -1, top: -1, width: 16, height: 16, borderRadius: 4 }}
          transition={tween}
          style={{ ...box, backgroundColor: filled ? primary : 'transparent' }}
        />
      )}
      {shown && (
        <motion.div key={`g${filled}`} initial={play ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={tween} style={{ ...box, left: 1, top: 1, width: 12, height: 12 }}>
          {indeterminate
            ? <svg source={DASH} style={{ ...box, left: 0, top: 0, width: 12, height: 12, color: d(t.v('--foreground'), boxFill) }} />
            : play
              ? <DrawnCheck color={d(t.v('--primary-foreground'))} size={12} />
              : <svg source={CHECK} style={{ ...box, left: 0, top: 0, width: 12, height: 12, color: d(t.v('--primary-foreground')) }} />}
        </motion.div>
      )}
      <FocusRing visible={focus.visible} radius={4} color={ring} offsetColor={t.v('--background')} />
    </div>
  )
}
