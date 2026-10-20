import { useLoopVisibility } from '../native/loop-visibility.ts'
import { formatElapsed } from '../../../../packages/kybern-client/src/subagents.ts'
import { ISLAND, useLoaderSecond } from '../MatrixLoader.tsx'
import { Label, useTheme } from '../ui.tsx'

/** SF Pro's tabular figure advance per size, measured with CoreText (`tnum`); GPUIX text has no `font-variant-numeric`. */
const FIGURE: Record<number, number> = { 11: 6.993, 12: 7.559, 13: 8.112 }

/**
 * A ticking duration. `tabular` sets each figure in a cell as wide as SF Pro's tabular figure (as `tabular-nums` would), so a
 * right-aligned clock keeps its width while it counts.
 */
export function Elapsed({ startedAt, endedAt, prefix = '', size = 11, tabular = false, color }: { startedAt: number; endedAt: number | null; prefix?: string; size?: number; tabular?: boolean; color?: string }) {
  const loop = useLoopVisibility(endedAt === null)
  useLoaderSecond(loop.visible)
  const t = useTheme()
  const text = `${prefix}${formatElapsed((endedAt ?? Date.now()) - startedAt)}`
  const ink = color ?? t.textTertiary
  if (!tabular) return <div ref={loop.ref} {...ISLAND}><Label color={ink} size={size}>{text}</Label></div>
  const figure = FIGURE[size] ?? size * 0.63
  return (
    <div ref={loop.ref} {...ISLAND} style={{ display: 'flex', flexShrink: 0 }}>
      {[...text].map((char, i) => /\d/.test(char)
        ? <div key={i} style={{ display: 'flex', justifyContent: 'center', width: figure, flexShrink: 0 }}><Label color={ink} size={size} lineHeight={size + 4}>{char}</Label></div>
        : <Label key={i} color={ink} size={size} lineHeight={size + 4} style={{ flexShrink: 0 }}>{char === ' ' ? ' ' : char}</Label>)}
    </div>
  )
}
