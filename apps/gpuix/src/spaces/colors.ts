// Space swatches (`docs/specs/spaces.md` §7.4): one fill per swatch in both themes. White text
// on every fill but amber reaches 4.3:1 or more for 15 px semibold initials.
import type { SpaceColor } from '../../../../packages/kybern-client/src/types.ts'

export const SWATCHES: Record<SpaceColor, { fill: string; fg: string }> = {
  blue: { fill: '#2F6FEB', fg: '#FFFFFF' },
  green: { fill: '#178A49', fg: '#FFFFFF' },
  purple: { fill: '#7346DB', fg: '#FFFFFF' },
  pink: { fill: '#C93A75', fg: '#FFFFFF' },
  teal: { fill: '#0F8A83', fg: '#FFFFFF' },
  amber: { fill: '#E09A1A', fg: '#1F1405' },
  red: { fill: '#D23F33', fg: '#FFFFFF' },
  graphite: { fill: '#5B6270', fg: '#FFFFFF' },
}
