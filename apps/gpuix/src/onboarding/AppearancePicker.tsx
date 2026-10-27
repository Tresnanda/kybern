// Preferences, left column, part 1 (SPEC §5): the three appearance cards, and `CardGroup`, the row of cards with ONE accent ring that
// slides between them (the Window material picker uses it too). Each card is a miniature (16:10, radius 12) with its label under it.
// Picking applies the theme at once (`setAppearance` snapshots the old frame, so the app's own `ThemeFade` cross-fades it: the
// prototype's circular reveal needs a clipped snapshot, which GPUIX cannot draw). The ring moves by `paintTranslate`; no React
// work per frame. Reduce Motion: the ring jumps, nothing lifts.
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { memo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { PaintTranslate } from '../drag/PaintTranslate.tsx'
import { useControls } from '../kit/controls.ts'
import { EASE } from '../motion/tokens.ts'
import { pressTransform } from '../motion/press.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { setAppearance, useAppearance, type Appearance } from '../settings/appearance.ts'
import { toast } from '../shell/toasts.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { bez } from './motion.tsx'
import { arrowTarget, CARD_GAP, CARD_PAD, CARD_RADIUS, cardHeight, cardX, labelLines, LABEL_LINE, PREVIEW_RADIUS, splitStop, SPLIT_ANGLE } from './prefsLayout.ts'

const RING_SPRING = { type: 'spring', duration: 0.45, bounce: 0.08 } as const

/** The ring: one element that moves to the selected card. Without the patched addon it is placed, not animated. */
function SlidingRing({ x, width, height, color }: { x: number; width: number; height: number; color: string }) {
  const ring = <div style={{ position: 'absolute', left: 0, top: 0, width, height, borderWidth: 2, borderColor: color, borderRadius: CARD_RADIUS, pointerEvents: 'none' }} />
  if (!PATCHED_NATIVE) return <div style={{ position: 'absolute', left: x, top: 0, width, height, pointerEvents: 'none' }}>{ring}</div>
  return (
    <PaintTranslate
      animate={{ translateX: x, translateY: 0 }}
      transition={REDUCED_MOTION ? { duration: 0 } : RING_SPRING}
      style={{ position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none' }}
    >
      {ring}
    </PaintTranslate>
  )
}

export interface CardOption<K extends string> { value: K; label: string; testId: string }

interface CardProps<K extends string> {
  option: CardOption<K>
  selected: boolean
  tabbable: boolean
  card: number
  height: number
  lines: number
  Preview: ComponentType<any>
  previewProps: object
  onPick: (value: K) => void
  onKey: (value: K, key: string) => void
  register: (value: K, node: PublicInstance | null) => void
}

function CardInner<K extends string>({ option, selected, tabbable, card, height, lines, Preview, previewProps, onPick, onKey, register }: CardProps<K>) {
  const t = useTheme()
  const c = useControls()
  const [hover, setHover] = useState(false)
  const lift = hover && PATCHED_NATIVE && !REDUCED_MOTION
  return (
    <div
      ref={(node) => register(option.value, node)}
      testId={option.testId}
      role="radio"
      aria-checked={selected}
      aria-label={option.label}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onPick(option.value)}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') { e.preventDefault(); onPick(option.value) } else onKey(option.value, e.key ?? '')
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      paintTransform={pressTransform(true)}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', width: card, height, flexShrink: 0, padding: CARD_PAD, paddingBottom: 8, gap: 8, borderRadius: CARD_RADIUS, cursor: 'pointer',
        hover: { backgroundColor: t.hover }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 2 },
      }}
    >
      <PaintTranslate animate={{ translateX: 0, translateY: lift ? -3 : 0 }} transition={{ duration: 0.15, ease: bez(EASE.out) }} style={{ display: 'flex', pointerEvents: 'none' }}>
        <Preview {...previewProps} />
      </PaintTranslate>
      <div style={{ display: 'flex', width: '100%', height: lines * LABEL_LINE, alignItems: 'flex-start', justifyContent: 'center', pointerEvents: 'none' }}>
        <Label color={selected ? t.text : t.textSecondary} size={13} lineHeight={LABEL_LINE} weight={600} style={{ textAlign: 'center', width: '100%' }}>{option.label}</Label>
      </div>
    </div>
  )
}
const Card = memo(CardInner) as typeof CardInner

/**
 * A radio group of cards laid out in one row, with one ring. `previews` are components of their own (so only the card whose
 * preview props changed paints again), `labels` decide whether the labels take a second line at this width.
 */
export function CardGroup<K extends string>({ label, options, value, card, previewHeight, previews, onPick }: {
  label: string
  options: readonly CardOption<K>[]
  value: K
  card: number
  previewHeight: number
  previews: ReadonlyArray<{ Preview: ComponentType<any>; props: object }>
  onPick: (value: K) => void
}) {
  const c = useControls()
  const renderer = useGpuixRequired()
  const nodes = useRef(new Map<K, PublicInstance>())
  const lines = labelLines(card, options.map((o) => o.label))
  const height = cardHeight(previewHeight, lines)
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const register = (key: K, node: PublicInstance | null) => { if (node) nodes.current.set(key, node); else nodes.current.delete(key) }
  const onKey = (key: K, pressed: string) => {
    const from = options.findIndex((o) => o.value === key)
    const to = arrowTarget(pressed, from, options.length, 'both')
    if (to === null) return
    const next = options[to]!.value
    onPick(next)
    const node = nodes.current.get(next)
    if (node) renderer.focusElement?.(node.id)
  }
  return (
    <div role="radiogroup" aria-label={label} style={{ position: 'relative', display: 'flex', flexDirection: 'row', gap: CARD_GAP, width: card * options.length + CARD_GAP * (options.length - 1), height }}>
      {options.map((option, i) => (
        <Card key={option.value} option={option} selected={i === index} tabbable={i === index} card={card} height={height} lines={lines} Preview={previews[i]!.Preview} previewProps={previews[i]!.props} onPick={onPick} onKey={onKey} register={register} />
      ))}
      <SlidingRing x={cardX(index, card)} width={card} height={height} color={c.accent} />
    </div>
  )
}

// ─── The appearance miniatures ────────────────────────────────────────────

const LOOK = {
  light: { sidebar: '#f4f4f4', content: '#ffffff', bar: 'rgba(0, 0, 0, 0.1)', composer: '#ffffff', composerEdge: 'rgba(0, 0, 0, 0.1)' },
  dark: { sidebar: '#1f1f20', content: '#181818', bar: 'rgba(255, 255, 255, 0.14)', composer: '#2a2a2a', composerEdge: 'rgba(255, 255, 255, 0.04)' },
} as const

const BARS = ['70%', '100%', '55%'] as const

/** A fill that is `a` before `stop` and `b` after it along the `SPLIT_ANGLE` diagonal. */
function split(a: string, b: string, stop: number) {
  if (stop <= 0.002) return { backgroundColor: b }
  if (stop >= 0.998) return { backgroundColor: a }
  return { background: { type: 'linear-gradient', angle: SPLIT_ANGLE, stops: [{ color: a, position: stop - 0.001 }, { color: b, position: stop + 0.001 }] } as never }
}

export interface MiniProps { kind: Appearance; width: number; height: number; edge: string }

/** A miniature app drawn in the colours of the theme it depicts, not the live theme. "Match system" splits light | dark on a diagonal. */
export const AppearanceMini = memo(function AppearanceMini({ kind, width, height, edge }: MiniProps) {
  const sb = Math.round(width * 0.3)
  const content = width - sb
  const comp = { width: Math.round(content * 0.8), height: 16 }
  const compBox = { x: sb + (content - comp.width) / 2, y: height - 8 - comp.height, ...comp }
  const system = kind === 'system'
  const side = LOOK[system ? 'light' : kind]
  const body = system ? split(LOOK.light.content, LOOK.dark.content, 0.5) : { backgroundColor: LOOK[kind].content }
  const composer = system
    ? split(LOOK.light.composer, LOOK.dark.composer, splitStop({ width, height }, compBox))
    : { backgroundColor: LOOK[kind].composer }
  return (
    <div
      style={{
        position: 'relative', display: 'flex', flexDirection: 'row', width, height, flexShrink: 0, borderRadius: PREVIEW_RADIUS, overflow: 'hidden', borderWidth: 1, borderColor: edge,
        boxShadow: { offsetX: 0, offsetY: 6, blurRadius: 14, spreadRadius: -8, color: 'rgba(0, 0, 0, 0.3)' }, ...body,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', width: sb, height: '100%', padding: 8, paddingLeft: 6, paddingRight: 6, gap: 4, backgroundColor: side.sidebar, flexShrink: 0 }}>
        {BARS.map((w) => <div key={w} style={{ width: w, height: 4, borderRadius: 2, backgroundColor: side.bar }} />)}
      </div>
      <div style={{ position: 'absolute', left: compBox.x, top: compBox.y, width: compBox.width, height: compBox.height, borderRadius: 6, borderWidth: 1, borderColor: system ? 'rgba(128, 128, 128, 0.25)' : LOOK[kind].composerEdge, ...composer }} />
    </div>
  )
})

const APPEARANCE: readonly CardOption<Appearance>[] = [
  { value: 'light', label: 'Light', testId: 'prefs-theme-light' },
  { value: 'dark', label: 'Dark', testId: 'prefs-theme-dark' },
  { value: 'system', label: 'Match system', testId: 'prefs-theme-system' },
]

export const AppearancePicker = memo(function AppearancePicker({ card, previewWidth, previewHeight }: { card: number; previewWidth: number; previewHeight: number }): ReactNode {
  const t = useTheme()
  const theme = useAppearance().theme
  const edge = t.contrast ? t.borderHeavy : t.border
  const previews = APPEARANCE.map((o) => ({ Preview: AppearanceMini, props: { kind: o.value, width: previewWidth, height: previewHeight, edge } satisfies MiniProps }))
  // Writes the saved theme. A file that cannot be saved leaves the old one showing, and the toast says why nothing moved.
  const pick = (value: Appearance) => { try { setAppearance({ theme: value }) } catch { toast.error('Couldn’t save the theme.', { description: 'Change it in Settings › Appearance.' }) } }
  return <CardGroup label="Appearance" options={APPEARANCE} value={theme} card={card} previewHeight={previewHeight} previews={previews} onPick={pick} />
})
