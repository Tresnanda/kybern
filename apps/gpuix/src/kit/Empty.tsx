// The desktop's `Empty` family (`components/kit/empty.tsx`): a centred empty state. `Empty` is the flex-1 column
// (gap 24, padding 48 at the app's window widths); `EmptyHeader` (max 384 px) runs `.t-stagger`: each child rises
// 12 px into place and fades in over 500 ms smooth-out (`--i` is unset, so all children move together; the
// desktop's 3 px blur has no GPUIX equivalent). `EmptyMedia variant="icon"` is a 36 px card (radius 8, `--card`,
// hairline, faint shadow) with two cards fanned out behind it (±10°, 84%, shifted 2 px; drawn as one SVG each,
// since GPUIX cannot rotate a div). `EmptyTitle` is 20/28 semibold, `EmptyDescription` 14/20 muted (4 px under a
// title), `EmptyContent` a 384 px column with 16 px gaps. Reduce Motion: no entrance (`.t-stagger > * { animation: none }`).
import type { StyleDesc } from '@gpuix/react'
import { Children, type ReactNode } from 'react'
import { Rise } from '../motion/kit.tsx'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'

export function Empty({ children, testId, style }: { children: ReactNode; testId?: string; style?: StyleDesc }) {
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, flexGrow: 1, minWidth: 0, padding: 48, ...style }}>{children}</div>
}

/** Plays the entrance on mount; `play={false}` renders at rest (content that was already there). */
export function EmptyHeader({ children, play = true, style }: { children: ReactNode; play?: boolean; style?: StyleDesc }) {
  const items = Children.toArray(children)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: 384, ...style }}>
      {items.map((child, i) => <Rise key={i} kind="stagger" index={0} play={play && !REDUCED_MOTION} style={{ alignItems: 'center' }}>{child}</Rise>)}
    </div>
  )
}

const CARD = 36
/** One fanned-out back card: the 36 px card at `bottom: 1px`, `translate-x ∓0.5 rotate ∓10° scale .84` about its bottom corner. */
function backCard(side: -1 | 1, paint: 'fill' | 'stroke', pad: number) {
  const ox = side < 0 ? 0 : CARD, oy = CARD - 1
  const transform = `translate(${ox} ${oy}) translate(${2 * side} 0) rotate(${10 * side}) scale(0.84) translate(${-ox} ${-oy})`
  const shape = paint === 'fill'
    ? `<rect x="0" y="-1" width="${CARD}" height="${CARD}" rx="8" fill="#000"/>`
    : `<rect x="0.5" y="-0.5" width="${CARD - 1}" height="${CARD - 1}" rx="7.5" fill="none" stroke="#000" stroke-width="1"/>`
  const size = CARD + pad * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-pad} ${-pad} ${size} ${size}"><g transform="${transform}">${shape}</g></svg>`
}
const PAD = 10
const BACK = { left: { fill: backCard(-1, 'fill', PAD), stroke: backCard(-1, 'stroke', PAD) }, right: { fill: backCard(1, 'fill', PAD), stroke: backCard(1, 'stroke', PAD) } }

export function EmptyMedia({ variant = 'default', icon, children }: { variant?: 'default' | 'icon'; /** Glyph source for the icon card (18 px). */ icon?: string; children?: ReactNode }) {
  const t = useTheme()
  if (variant === 'default') return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginBottom: 24 }}>{children}</div>
  const dark = t.variant === 'dark'
  const card = t.v('--card')
  const border = t.v('--border')
  const layer: StyleDesc = { position: 'absolute', left: -PAD, top: -PAD, width: CARD + PAD * 2, height: CARD + PAD * 2, pointerEvents: 'none' }
  return (
    <div style={{ position: 'relative', width: CARD, height: CARD, flexShrink: 0, marginBottom: 24 }}>
      {(['left', 'right'] as const).map((side) => (
        <div key={side} style={{ ...layer, left: -PAD, top: -PAD }}>
          <svg source={BACK[side].fill} style={{ ...layer, left: 0, top: 0, color: card }} />
          <svg source={BACK[side].stroke} style={{ ...layer, left: 0, top: 0, color: border }} />
        </div>
      ))}
      <div style={{ position: 'absolute', left: 0, top: 0, width: CARD, height: CARD, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: border, backgroundColor: card, boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 3 / 2, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.05)' } }}>
        {/* `before:shadow-[0_-1px_white/6%]` (dark) / `[0_1px_black/4%]` (light): a 1px edge line just outside the padding box. */}
        <div style={{ position: 'absolute', left: 0, right: 0, height: 8, borderRadius: 7, pointerEvents: 'none', ...(dark ? { top: -1, borderTopWidth: 1, borderColor: 'rgba(255, 255, 255, 0.06)' } : { bottom: -1, borderBottomWidth: 1, borderColor: 'rgba(0, 0, 0, 0.04)' }) }} />
        {icon ? <svg source={icon} style={{ width: 18, height: 18, color: t.text, pointerEvents: 'none' }} /> : children}
      </div>
    </div>
  )
}

export function EmptyTitle({ children }: { children: string }) {
  const t = useTheme()
  return <Label color={t.text} size={20} lineHeight={28} weight={600} style={{ textAlign: 'center' }}>{children}</Label>
}

export function EmptyDescription({ children, afterTitle = true }: { children: string; /** `[[data-slot=empty-title]+&]:mt-1`. */ afterTitle?: boolean }) {
  const t = useTheme()
  return <Label color={t.v('--muted-foreground')} size={14} lineHeight={20} style={{ textAlign: 'center', marginTop: afterTitle ? 4 : 0 }}>{children}</Label>
}

export function EmptyContent({ children, style }: { children: ReactNode; style?: StyleDesc }) {
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%', minWidth: 0, maxWidth: 384, ...style }}>{children}</div>
}
