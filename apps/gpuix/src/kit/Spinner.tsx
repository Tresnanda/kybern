// The desktop's `Spinner` (`components/kit/spinner.tsx`): the Loader2 glyph (Hugeicons Loading03 at the kit stroke)
// with `animate-spin` (one turn a second, linear), `role="status"`, "Loading". Default 24 px like the bare SVG;
// call sites pass `size` (12-15). Built on `SpinIcon` (native `rotate` paint animation, no JS clock).
// Reduce Motion: SpinIcon holds the glyph still, whereas the desktop's `animate-spin` keeps turning.
import type { StyleDesc } from '@gpuix/react'
import { N } from '../nav/glyphs.ts'
import { useTheme } from '../ui.tsx'
import { SpinIcon } from './Spin.tsx'

export function Spinner({ size = 24, color, spinning = true, testId, style }: { size?: number; color?: string; spinning?: boolean; testId?: string; style?: StyleDesc }) {
  const t = useTheme()
  return (
    <div role="status" aria-label="Loading" style={{ display: 'flex', flexShrink: 0, width: size, height: size, pointerEvents: 'none', ...style }}>
      <SpinIcon source={N.loader} size={size} color={color ?? t.text} spinning={spinning} testId={testId} />
    </div>
  )
}
