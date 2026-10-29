// The machine glyph (design §5.2): a small OS-neutral monogram, the first letter of the machine's name, tinted from
// its id so it is the same on every client. A single element, so a thread row stays one flex row (`native/README.md`,
// wrapper layout cost). With `name` the badge says the machine's full name in a tooltip (two machines can share a letter).
import type { MachineGlyph } from '../../../../packages/kybern-client/src/machineMerge.ts'
import { Tip } from '../nav/overlay.tsx'
import { Label, useTheme } from '../ui.tsx'

export const SIZE = 14

export function MachineBadge({ glyph, size = SIZE, testId, name }: { glyph: MachineGlyph; size?: number; testId?: string; name?: string }) {
  const dark = useTheme().variant === 'dark'
  const tint = (l: number, c: number) => `oklch(${l} ${c} ${glyph.hue})`
  // Two letters ("Sa") are set smaller so they stay inside the square.
  const letterSize = Math.round(size * (glyph.letter.length > 1 ? 0.5 : 0.66))
  const badge = (
    <div testId={testId} aria-label={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: 4, flexShrink: 0, backgroundColor: tint(dark ? 0.36 : 0.92, dark ? 0.07 : 0.05) }}>
      <Label color={tint(dark ? 0.84 : 0.42, 0.12)} size={letterSize} weight={600} lineHeight={size} style={{ pointerEvents: 'none' }}>{glyph.letter}</Label>
    </div>
  )
  return name ? <Tip label={name} size={size}>{badge}</Tip> : badge
}
