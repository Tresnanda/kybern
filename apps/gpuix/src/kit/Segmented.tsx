// The desktop's `SegmentedControl` (`components/kit/segmented-control.tsx`): a radiogroup on the recessed
// `.sidebar-segmented-picker` track (kit.css:2886-2902: 1px ink 8%/7% hairline, `--background` / elevated-secondary
// fill, inset shadow, radius 8, 2px padding, 2px gaps) with one raised `.sidebar-segmented-thumb` (kit.css:2911-2933)
// that slides between 24px segments (`.t-tabs-pill`: left/width 250 ms smooth-out; the first placement lands without
// motion). Arrow keys move the choice and the focus (roving tab index), skipping `unavailable` options, which stay
// visible, explain themselves in a tooltip and ignore input. While `busy` the control keeps focus but ignores input.
// Reduce Motion: the pill jumps (`.t-tabs-pill { transition: none }`).
import { motion, useGpuixRequired, type PublicInstance, type StyleDesc } from '@gpuix/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Tip } from '../nav/overlay.tsx'
import { over } from '../theme.ts'
import { DURATION, EASE } from '../motion/kit.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { FocusRing, useFocusRing, withAlpha } from './Switch.tsx'

export interface SegmentedOption {
  value: string
  label: string
  /** Why this option cannot be chosen right now (tooltip); arrow keys skip it. */
  unavailable?: string | null
}

export interface SegmentedProps {
  options: readonly SegmentedOption[]
  value: string
  onChange: (value: string) => void
  busy?: boolean
  'aria-label'?: string
  /** Segment text size: the desktop inherits it (`SEGMENT_TEXT` is `--app-font-size-ui`, 14 px by default). */
  textSize?: number
  /** Segment height (24; the PR list uses 28) and horizontal padding (8; the PR list uses 10). */
  segmentHeight?: number
  segmentPadX?: number
  /** Stretch to the parent's width with equal segments (`FULL_WIDTH_SEGMENTS`). */
  fill?: boolean
  testId?: string
  style?: StyleDesc
}

type Box = { x: number; w: number }

export function Segmented({ options, value, onChange, busy = false, 'aria-label': label, textSize = 14, segmentHeight = 24, segmentPadX = 8, fill = false, testId, style }: SegmentedProps) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const track = useRef<PublicInstance>(null)
  const buttons = useRef(new Map<string, PublicInstance>())
  const [boxes, setBoxes] = useState<Record<string, Box> | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const focus = useFocusRing()
  const dark = t.variant === 'dark'
  const layoutKey = options.map((o) => `${o.value}:${o.label}`).join(',') + `|${textSize}|${segmentPadX}|${fill}`

  // Measure each segment after layout (offsets from the track's padding box), retrying until GPUI has laid it out.
  useLayoutEffect(() => {
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      const root = track.current ? renderer.getElementBounds?.(track.current.id) : null
      const next: Record<string, Box> = {}
      for (const o of options) {
        const b = buttons.current.get(o.value)
        const r = b ? renderer.getElementBounds?.(b.id) : null
        if (!root || !r || r.width === 0) { if (++tries < 20) timer = setTimeout(measure, 16); return }
        next[o.value] = { x: r.x - root.x - 1, w: r.width }
      }
      setBoxes(next)
    }
    measure()
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey])

  const placed = useRef(false)
  const pill = boxes?.[value]
  // The first measured placement does not slide (`data-ready="false"`).
  const slide = placed.current && !REDUCED_MOTION
  if (pill) placed.current = true

  const choose = (next: string) => {
    if (busy || next === value || options.find((o) => o.value === next)?.unavailable) return
    onChange(next)
  }
  const step = (dir: number) => {
    if (busy) return
    const index = options.findIndex((o) => o.value === value)
    for (let offset = 1; offset <= options.length; offset++) {
      const next = options[(index + dir * offset + options.length * offset) % options.length]!
      if (next.unavailable || next.value === value) continue
      choose(next.value)
      const node = buttons.current.get(next.value)
      if (node) renderer.focusElement?.(node.id)
      break
    }
  }

  const thumbFill = dark ? t.v('--composer-surface') : over(t.v('--composer-surface'), over(t.v('--color-background-elevated-secondary'), t.v('--background')))
  return (
    <div
      ref={track}
      testId={testId}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        const dir = e.key === 'right' || e.key === 'down' ? 1 : e.key === 'left' || e.key === 'up' ? -1 : 0
        if (!dir) return
        e.preventDefault()
        focus.keyed()
        step(dir)
      }}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', alignSelf: fill ? 'stretch' : 'flex-start', gap: 2, padding: 2, minWidth: 0, flexShrink: fill ? 1 : 0,
        borderWidth: 1, borderColor: ink(t, dark ? 0.08 : 0.07), borderRadius: 8, overflow: 'hidden',
        backgroundColor: dark ? t.v('--background') : t.v('--color-background-elevated-secondary'),
        ...style,
      }}
    >
      {/* `box-shadow: inset 0 1px 2px rgba(0,0,0,.25 | .06)`: a soft shade under the top edge. */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, pointerEvents: 'none', background: { type: 'linear-gradient', angle: 180, stops: [{ color: `rgba(0, 0, 0, ${dark ? 0.2 : 0.05})`, position: 0 }, { color: 'rgba(0, 0, 0, 0)', position: 1 }] } }} />
      {pill && (() => {
        const style = {
          position: 'absolute', top: 1, height: segmentHeight, borderRadius: 6, borderWidth: 1, pointerEvents: 'none',
          borderColor: ink(t, dark ? 0.07 : 0.05), backgroundColor: thumbFill,
          boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 1.5 / 2, spreadRadius: 0, color: `rgba(0, 0, 0, ${dark ? 0.16 : 0.04})` },
        } as const
        // `inset 0 1px 0 rgba(255,255,255,.04 | .5)`: the raised rim's top highlight.
        const rim = <div style={{ position: 'absolute', left: 1, right: 1, top: 0, height: 1, backgroundColor: `rgba(255, 255, 255, ${dark ? 0.04 : 0.5})`, pointerEvents: 'none' }} />
        const ease = [...EASE.smoothOut] as [number, number, number, number]
        // Equal-width segments (`fill`, or labels that happen to match): the pill only moves, so it slides as a paint-only translation
        // from the first segment's slot (no layout or render per frame). Different widths also change the pill's width, which needs the
        // layout tween.
        const first = boxes?.[options[0]!.value]
        if (first && PATCHED_NATIVE && options.every((o) => Math.abs((boxes?.[o.value]?.w ?? -1) - pill.w) < 0.5)) {
          return (
            <div
              paintTransform={{ initial: false, animate: { translateX: pill.x - first.x }, transition: { duration: slide ? DURATION.fast : 0, ease } }}
              style={{ ...style, left: first.x, width: pill.w }}
            >
              {rim}
            </div>
          )
        }
        return (
          <motion.div initial={false} animate={{ left: pill.x, width: pill.w }} transition={{ duration: slide ? DURATION.fast : 0, ease }} style={style}>
            {rim}
          </motion.div>
        )
      })()}
      {options.map((option) => {
        const selected = option.value === value
        const blocked = !!option.unavailable
        const color = selected || (hover === option.value && !blocked && !busy) ? t.text : blocked ? withAlpha(t.v('--muted-foreground'), 0.4) : t.v('--muted-foreground')
        const button = (
          <div
            key={option.value}
            ref={(node: PublicInstance | null) => { if (node) buttons.current.set(option.value, node); else buttons.current.delete(option.value) }}
            testId={testId ? `${testId}-${option.value}` : undefined}
            role="radio"
            aria-label={option.label}
            aria-checked={selected}
            aria-disabled={busy || blocked || undefined}
            tabIndex={selected ? 0 : -1}
            onMouseEnter={() => setHover(option.value)}
            onMouseLeave={() => setHover((h) => (h === option.value ? null : h))}
            onMouseDown={focus.handlers.onMouseDown}
            onFocus={() => { focus.handlers.onFocus(); setFocused(option.value) }}
            onBlur={() => { focus.handlers.onBlur(); setFocused((f) => (f === option.value ? null : f)) }}
            onClick={() => choose(option.value)}
            onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') choose(option.value) }}
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', height: segmentHeight, minWidth: 36, paddingLeft: segmentPadX, paddingRight: segmentPadX, borderRadius: 6,
              cursor: busy || blocked ? 'default' : 'pointer', ...(fill ? { flexGrow: 1, flexBasis: 0, minWidth: 0 } : { flexShrink: 0 }),
            }}
          >
            <Label color={color} size={textSize} truncate={fill} style={{ pointerEvents: 'none' }}>{option.label}</Label>
            {/* `focus-visible:ring-1 ring-ring` (no offset). */}
            <FocusRing visible={focus.visible && focused === option.value} radius={6} width={1} offset={0} color={t.v('--ring')} />
          </div>
        )
        return blocked ? <Tip key={option.value} label={option.unavailable!} side="top" sideOffset={6} size={segmentHeight}>{button}</Tip> : button
      })}
    </div>
  )
}
