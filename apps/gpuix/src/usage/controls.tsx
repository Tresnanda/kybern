import { motion, type StyleDesc } from '@gpuix/react'
import { useState, type ReactNode } from 'react'
import { setNav } from '../nav/store.ts'
import { Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { pressTransform } from '../motion/press.ts'
import { DURATION, EASE } from '../motion/tokens.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'

export const row: StyleDesc = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
export const column: StyleDesc = { display: 'flex', flexDirection: 'column', minWidth: 0 }

export function Button({ children, onClick, testId, disabled, primary, style, label }: { label?: string; children: ReactNode; onClick?: () => void; testId?: string; disabled?: boolean; primary?: boolean; style?: StyleDesc }) {
  const t = useTheme()
  // A button drawn inside Menu's trigger is decorative. Its wrapper owns input.
  const run = () => { if (!disabled) onClick?.() }
  return <div testId={testId} role="button" aria-label={label ?? (typeof children === 'string' ? children : undefined)} tabIndex={disabled || !onClick ? -1 : 0} onClick={onClick ? run : undefined} onKeyDown={onClick ? e => { if (e.key === 'enter' || e.key === 'space') { setNav({ keyboardNav: true }); run() } } : undefined} paintTransform={pressTransform(!!onClick && !disabled)} style={{ ...row, pointerEvents: onClick ? 'auto' : 'none', justifyContent: 'center', height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 8, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .5 : 1, backgroundColor: primary ? t.buttonPrimary : 'transparent', hover: { backgroundColor: disabled ? 'transparent' : primary ? t.buttonPrimary : t.buttonTertiaryHover }, active: { backgroundColor: t.buttonSecondaryHover }, ...style }}>{typeof children === 'string' || typeof children === 'number' ? <Label color={primary ? t.buttonPrimaryText : t.text} size={14} lineHeight={21}>{children}</Label> : children}</div>
}

/**
 * The sliding selection of a segmented control or tab strip (`t-tabs`: 250 ms `--ease-smooth-out`), `x` px from the strip's inner left
 * edge. Equal-width segments move the pill by paint (`paintTransform` translation: no layout or render per frame, like the rail's
 * pill); segments of different widths change `left` and `width`, so that case is the short layout tween. A keyboard move, Reduce
 * Motion and the stock addon change at once.
 */
export function SlidingPill({ x, width, equal, instant, top = 3, height = 28, radius = 5, color }: { x: number; width: number; equal: boolean; instant: boolean; top?: number; height?: number; radius?: number; color: string }) {
  const duration = REDUCED_MOTION || instant ? 0 : DURATION.fast
  const ease = [...EASE.smoothOut] as [number, number, number, number]
  const box = { position: 'absolute', top, height, borderRadius: radius, backgroundColor: color, pointerEvents: 'none' } as const
  if (equal && PATCHED_NATIVE) return <div paintTransform={{ initial: false, animate: { translateX: x }, transition: { duration, ease } }} style={{ ...box, left: 3, width }} />
  if (equal) return <div style={{ ...box, left: 3 + x, width }} />
  return <motion.div initial={false} animate={{ left: 3 + x, width }} transition={{ duration, ease }} style={box} />
}

/** Fixed-width segments let the native pill move without a measurement loop. `onChange` also says whether the keyboard chose the segment, so callers can skip entrance motion for it. */
export function Segments<T extends string>({ value, options, onChange, testId, width = 72, plain = false, fontSize = 14 }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (value: T, byKey?: boolean) => void; testId: string; width?: number | readonly number[]; plain?: boolean; fontSize?: number }) {
  const t = useTheme()
  const [instant, setInstant] = useState(true)
  const index = options.findIndex(([key]) => key === value)
  const widths = options.map((_, i) => typeof width === 'number' ? width : width[i] ?? 72)
  const left = widths.slice(0, Math.max(0,index)).reduce((a,b)=>a+b,0)
  return <div role="tablist" aria-label={testId} style={{ ...row, gap: 0, alignSelf: 'flex-start', position: 'relative', padding: 3, height: 34, borderRadius: 8, backgroundColor: plain ? 'transparent' : t.buttonSecondary }}>
    <SlidingPill x={left} width={widths[Math.max(0,index)]!} equal={widths.every(w => w === widths[0])} instant={instant} color={plain ? t.buttonSecondary : t.surface} />
    {options.map(([key, label], i) => <div key={key} testId={`${testId}-${key}`} role="tab" aria-selected={key === value} tabIndex={0} paintTransform={pressTransform(true)} onClick={() => { setInstant(false); onChange(key, false) }} onKeyDown={e => {
      const next = e.key === 'right' ? (i + 1) % options.length : e.key === 'left' ? (i + options.length - 1) % options.length : e.key === 'enter' || e.key === 'space' ? i : -1
      if (next >= 0) { setInstant(true); onChange(options[next]![0], true) }
    }} style={{ ...row, width: widths[i], height: 28, justifyContent: 'center', cursor: 'pointer' }}>{typeof label === 'string' ? <Label color={key === value ? t.text : t.textSecondary} size={fontSize} lineHeight={21}>{label}</Label> : label}</div>)}
  </div>
}

export function Header({ title, children }: { title: string; children?: ReactNode }) {
  const t = useTheme()
  return <div style={{ ...row, height: 46, flexShrink: 0, paddingLeft: 20, paddingRight: 12, borderBottomWidth: 1, borderColor: t.border }}><Label color={t.text} size={14} weight={500} style={{ flexGrow: 1 }}>{title}</Label>{children}</div>
}
