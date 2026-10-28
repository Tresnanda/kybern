// The five tones a status can have, as colours: the verdict card, status chips and check glyphs read the same mapping, so a tone looks
// the same everywhere. `success` green, `info` blue, `warning` amber, `danger` red, `neutral` a quiet ink.
import type { Theme } from '../theme.ts'

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

export function toneColor(t: Theme, tone: Tone): string {
  switch (tone) {
    case 'success': return t.green
    case 'info': return t.accentBlue
    case 'warning': return t.warning
    case 'danger': return t.red
    default: return t.variant === 'dark' ? 'rgba(252, 252, 252, 0.42)' : 'rgba(13, 13, 13, 0.42)'
  }
}
