// Motion helpers shared by the scenes. Everything moves by `paintTransform` / `paintTranslate` (no React work per frame),
// retargets from the on-screen value, and under Reduce Motion becomes a short cross-fade (SPEC §8, §9).
import type { PaintTransformProps, PaintTransformValue } from '@gpuix/native/host'
import type { StyleDesc } from '@gpuix/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { PaintTranslate } from '../drag/PaintTranslate.tsx'
import { EASE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Label, REDUCED_MOTION } from '../ui.tsx'

export const bez = (e: readonly number[]) => [...e] as [number, number, number, number]
/** The SPEC's `cubic-bezier(.45,0,.2,1)` settle and `.65,0,.25,1` flight. */
export const SETTLE = [0.45, 0, 0.2, 1] as const
export const FLIGHT = [0.65, 0, 0.25, 1] as const
export const REST: Required<PaintTransformValue> = { opacity: 1, scale: 1, scaleX: 1, scaleY: 1, shadowOpacity: 1, rotate: 0, translateX: 0, translateY: 0, blur: 0 }
const restOf = (from: PaintTransformValue): PaintTransformValue => Object.fromEntries(Object.keys(from).map((k) => [k, REST[k as keyof typeof REST]]))

/** The reduced-motion stand-in for any entrance: a 150 ms opacity fade. */
const FADE: PaintTransformProps = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15, ease: bez(EASE.out) } }

export interface RiseOptions {
  /** Seconds before it starts. */
  delay?: number
  duration?: number
  y?: number
  x?: number
  scale?: number
  blur?: number
  ease?: readonly number[]
  /** The intro was skipped: 150 ms, no delay, no travel. */
  fast?: boolean
  origin?: [number, number]
}

/**
 * The entrance every `data-in` child of the prototype uses: rise `y` px and fade (SPEC §1). No blur by default: every settling blur
 * re-renders the whole window once, and a scene arrives with a dozen of these staggered (see the README's "Frame cost").
 */
export function riseTransform({ delay = 0, duration = 0.5, y = 14, x = 0, scale, blur = 0, ease = EASE.out, fast = false, origin }: RiseOptions = {}): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  if (REDUCED_MOTION || fast) return FADE
  const initial: PaintTransformValue = { opacity: 0 }
  if (y) initial.translateY = y
  if (x) initial.translateX = x
  if (scale !== undefined) initial.scale = scale
  if (blur) initial.blur = blur
  return { initial, animate: restOf(initial), transition: { duration, delay, ease: bez(ease) }, ...(origin ? { origin } : {}) }
}

/** A child that rises into place once on mount. `play={false}` renders it plainly. */
export function In({ children, style, play = true, testId, ...options }: RiseOptions & { children: ReactNode; style?: StyleDesc; play?: boolean; testId?: string }) {
  return <div testId={testId} paintTransform={play ? riseTransform(options) : undefined} style={{ display: 'flex', flexDirection: 'column', ...style }}>{children}</div>
}

/** Retained opacity/transform that changes with state and retargets from where it is on screen. */
export function stateTransform(to: PaintTransformValue, { duration = 0.3, ease = EASE.out, delay = 0, origin, generation }: { duration?: number; ease?: readonly number[]; delay?: number; origin?: [number, number]; generation?: number } = {}): PaintTransformProps | undefined {
  if (!PATCHED_NATIVE) return undefined
  const reduced = REDUCED_MOTION
  return {
    initial: false,
    animate: reduced ? { opacity: to.opacity ?? 1 } : to,
    transition: { duration: reduced ? 0.15 : duration, ease: bez(ease), delay: reduced ? 0 : delay },
    ...(origin ? { origin } : {}),
    ...(generation !== undefined ? { generation } : {}),
    retain: true,
  }
}

/** A word-by-word headline: each word rises and fades, 70 ms apart (SPEC §2; no blur, see `riseTransform`). Lines are laid out whole from the first frame. */
export function Words({ lines, size, lineHeight, color, font, base = 0.18, step = 0.07, fast = false, weight, onDone }: {
  lines: readonly (readonly string[])[]
  size: number
  lineHeight: number
  color: string
  font?: string
  base?: number
  step?: number
  fast?: boolean
  weight?: number
  onDone?: () => void
}) {
  let index = 0
  const total = lines.reduce((n, line) => n + line.length, 0)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!done.current) return
    const timer = setTimeout(() => done.current?.(), fast || REDUCED_MOTION ? 160 : (base + total * step + 0.65) * 1000)
    return () => clearTimeout(timer)
  }, [fast, base, step, total])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {lines.map((line, row) => (
        <div key={row} style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', columnGap: Math.round(size * 0.24), height: lineHeight }}>
          {line.map((word) => {
            const i = index++
            return (
              <div key={`${row}:${word}:${i}`} paintTransform={riseTransform({ delay: base + i * step, duration: 0.65, y: Math.round(size * 0.32), fast })} style={{ display: 'flex' }}>
                <Label color={color} size={size} lineHeight={lineHeight} font={font} weight={weight} style={{ whiteSpace: 'nowrap' }}>{word}</Label>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** Split `text` into `n` lines with about equal character counts, the browser's `text-wrap: balance` by hand. */
export function balance(text: string, maxChars: number): string[][] {
  const words = text.split(' ')
  const lines = Math.max(1, Math.ceil(text.length / maxChars))
  if (lines === 1) return [words]
  const target = text.length / lines
  const out: string[][] = [[]]
  let used = 0
  for (const word of words) {
    const row = out[out.length - 1]!
    if (row.length > 0 && out.length < lines && used + word.length / 2 > target) { out.push([word]); used = word.length } else { row.push(word); used += word.length + 1 }
  }
  return out
}

// ─── Rolling numbers ──────────────────────────────────────────────────────

const FORMAT = new Intl.NumberFormat('en')
/**
 * One column of digits behind a clip, moved with a retained translation: the value rolls to its place (SPEC §7). The column holds
 * only the digits the roll passes through (`lo`…`hi`), not all ten: a lede, the chips and the buttons carry about twenty of these,
 * and every commit of the scene rebuilds them, so ten labels each made a Projects draw ~4 ms dearer. Looks the same.
 */
function Digit({ digit, width, height, size, color, weight, duration }: { digit: number; width: number; height: number; size: number; color: string; weight?: number; duration: number }) {
  const roll = useRef<{ digit: number; lo: number; hi: number; until: number; gen: number; from: number | null }>({ digit, lo: digit, hi: digit, until: 0, gen: 0, from: null })
  const r = roll.current
  if (r.digit !== digit) {
    const now = Date.now()
    // Mid-roll the column keeps what it holds, so the roll retargets from where it is; once settled it is cut down to this roll.
    const lo = now < r.until ? Math.min(r.lo, digit) : Math.min(r.digit, digit)
    const hi = now < r.until ? Math.max(r.hi, digit) : Math.max(r.digit, digit)
    // A new top of the column shifts every cell: restart from the old digit's place in the new column.
    const from = lo !== r.lo ? -(r.digit - lo) * height : null
    roll.current = { digit, lo, hi, until: now + duration * 1000, gen: r.gen + (from !== null ? 1 : 0), from }
  }
  const { lo, hi, gen, from } = roll.current
  const cells: number[] = []
  for (let d = lo; d <= hi; d++) cells.push(d)
  return (
    <div cache style={{ width, height, overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
      <PaintTranslate
        key={gen}
        initial={from === null ? false : { translateX: 0, translateY: from }}
        animate={{ translateX: 0, translateY: -(digit - lo) * height }}
        transition={REDUCED_MOTION || !PATCHED_NATIVE ? { duration: 0 } : { duration, ease: bez(EASE.out) }}
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        {cells.map((d) => (
          <div key={d} style={{ display: 'flex', justifyContent: 'center', width, height, flexShrink: 0 }}>
            <Label color={color} size={size} lineHeight={height} weight={weight}>{String(d)}</Label>
          </div>
        ))}
      </PaintTranslate>
    </div>
  )
}

/** A number whose digits roll to their place when it changes (700 ms `EASE.out`). Without the patched addon it is plain text. */
export function Roll({ value, size, color, weight, lineHeight = size + 4, duration = 0.7, style }: { value: number; size: number; color: string; weight?: number; lineHeight?: number; duration?: number; style?: StyleDesc }) {
  const text = FORMAT.format(Math.max(0, Math.round(value)))
  if (!PATCHED_NATIVE) return <Label color={color} size={size} lineHeight={lineHeight} weight={weight} style={{ whiteSpace: 'nowrap', ...style }}>{text}</Label>
  const cell = Math.round(size * 0.6 * 100) / 100
  const chars = [...text]
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexShrink: 0, ...style }}>
      {chars.map((char, i) => {
        // Key by place from the right, so the units digit keeps its column when a new leading digit appears.
        const place = chars.length - i
        return /\d/.test(char)
          ? <Digit key={`d${place}`} digit={Number(char)} width={cell} height={lineHeight} size={size} color={color} weight={weight} duration={duration} />
          : <Label key={`s${place}`} color={color} size={size} lineHeight={lineHeight} weight={weight} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{char}</Label>
      })}
    </div>
  )
}
