// `<CheckIcon className="t-success" />`: the check rotates, scales and bobs into place (`successTransform`) while its stroke
// draws itself in (`successStroke`), both painted natively (`motion/success.ts`). `play: false` (or Reduce Motion, or the stock
// addon) shows it at rest.
import { N } from '../nav/glyphs.ts'
import { successStroke, successTransform } from './success.ts'

export function SuccessCheck({ size, color, play = true, testId }: { size: number; color: string; play?: boolean; testId?: string }) {
  const stroke = play ? successStroke() : undefined
  return (
    <div testId={testId} paintTransform={play ? successTransform() : undefined} style={{ display: 'flex' }}>
      <svg source={N.check} {...(stroke ? { paintAnimation: stroke } : {})} style={{ width: size, height: size, flexShrink: 0, color }} />
    </div>
  )
}
