// `DisclosureChevron` (`lib/kit/disclosureMotion.ts`, 220 ms `--ease-out`): a chevron that rotates with the content it controls
// instead of swapping glyphs. The glyph is one sprite in a fixed `size × size` box, rotated by `paintTransform` (exact for glyph
// subtrees, painted natively: no layout, render or island work per frame, no layout shift).
import { N } from '../nav/glyphs.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { DISCLOSURE, EASE } from './tokens.ts'

/**
 * A chevron that turns `turn` degrees (default 90: right → down) when `open`. The first render shows the end state with no
 * rotation on mount; later changes tween over `duration` seconds (default `DISCLOSURE`, 220 ms, `--ease-out`) and retarget from
 * the angle on screen, so a quick second click reverses smoothly. Keyboard toggles rotate too: the rotation never delays content.
 *
 * `source` is the glyph (default `N.chevronRight`); a picker chevron that flips 180° up uses `source={N.chevronDown} turn={180}
 * duration={0.25}` (`SettingsScreen` select chevron). Reduce Motion rotates at once. With the stock addon (no `paintTransform`)
 * a 90° chevron swaps its glyph right ↔ down like the old `DisclosureChevron`.
 */
export function Chevron({ open, size = 14, color, turn = 90, source = N.chevronRight, duration = DISCLOSURE, testId }: { open: boolean; size?: number; color: string; turn?: number; source?: string; duration?: number; testId?: string }) {
  if (!PATCHED_NATIVE) return <div testId={testId} style={{ display: 'flex', width: size, height: size, flexShrink: 0 }}><Icon source={turn === 90 && source === N.chevronRight && open ? N.chevronDown : source} size={size} color={color} /></div>
  return (
    <div
      testId={testId}
      paintTransform={{ initial: false, animate: { rotate: open ? turn : 0 }, transition: { duration: REDUCED_MOTION ? 0 : duration, ease: [...EASE.out] } }}
      style={{ display: 'flex', width: size, height: size, flexShrink: 0 }}
    >
      <Icon source={source} size={size} color={color} />
    </div>
  )
}
