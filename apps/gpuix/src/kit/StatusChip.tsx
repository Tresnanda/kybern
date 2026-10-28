// A tinted status chip: the tone at about 11% behind a 14 px glyph in the tone and the label in normal ink (a reviewer's state, a
// label, "Required"). 22 px high, radius 6, so it sits on a 32 px inspector row. `dot` swaps the glyph for a 7 px dot (labels).
import { Icon } from '../icons.tsx'
import { alpha } from '../transcript/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { RADIUS } from './controls.ts'
import { toneColor, type Tone } from './tone.ts'

export function StatusChip({ tone = 'neutral', icon, dot, children, testId }: { tone?: Tone; /** A glyph source (`pulls/detail/glyphs.ts`, `N.*`). */ icon?: string; /** A colour for the 7 px dot of a label chip. */ dot?: string; children: string; testId?: string }) {
  const t = useTheme()
  const color = toneColor(t, tone)
  const fill = tone === 'neutral' ? (t.variant === 'dark' ? 'rgba(252, 252, 252, 0.06)' : 'rgba(13, 13, 13, 0.05)') : alpha(color, t.variant === 'dark' ? 0.11 : 0.12)
  return (
    <div testId={testId} style={{ display: 'flex', alignItems: 'center', gap: dot ? 6 : 5, height: 22, paddingLeft: icon ? 5 : 7, paddingRight: 7, borderRadius: RADIUS.sm - 2, backgroundColor: fill, flexShrink: 0, maxWidth: '100%' }}>
      {icon && <Icon source={icon} size={14} color={color} />}
      {dot && <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: dot, flexShrink: 0 }} />}
      <Label color={t.text} size={12} lineHeight={16} weight={500} truncate>{children}</Label>
    </div>
  )
}
