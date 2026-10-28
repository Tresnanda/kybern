// A raised card: radius 13 (`RADIUS.xl`), padding 14, 10 between its parts. `tone` tints it (the tone at about 7% with a 1 px edge of
// the tone at 17%): the pull request verdict. Without a tone it is the neutral card (ink 3.5%, the theme's `cardEdge`).
import type { StyleDesc } from '@gpuix/react'
import type { ReactNode } from 'react'
import { alpha } from '../transcript/kit.tsx'
import { useTheme } from '../ui.tsx'
import { RADIUS } from './controls.ts'
import { toneColor, type Tone } from './tone.ts'

export function Card({ tone, children, testId, style }: { tone?: Tone; children: ReactNode; testId?: string; style?: StyleDesc }) {
  const t = useTheme()
  const color = tone && tone !== 'neutral' ? toneColor(t, tone) : null
  const fill = color ? alpha(color, 0.07) : t.variant === 'dark' ? 'rgba(252, 252, 252, 0.035)' : 'rgba(13, 13, 13, 0.03)'
  const edge = color ? alpha(color, 0.17) : t.cardEdge
  return <div testId={testId} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 10, padding: 13, borderRadius: RADIUS.xl, borderWidth: 1, borderColor: edge, backgroundColor: fill, ...style }}>{children}</div>
}
