// The sidebar title marquee alone (`sidebar/motion.tsx` `MarqueeLabel`): a long title in a 220 px row box, hovered from the
// start, so `marquee-check.ts` can watch its pan as WindowServer presents it.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { MarqueeLabel } from '../src/sidebar/motion.tsx'
import { ThemeProvider, useTheme } from '../src/ui.tsx'

export const TITLE = 'Investigating kybern GPUIX 350 MB RAM usage after navigating between long threads'
function Lab() {
  const t = useTheme()
  return (
    <div testId="ready" style={{ width: '100%', height: '100%', backgroundColor: t.surface, padding: 32, display: 'flex', flexDirection: 'column' }}>
      <div testId="row" style={{ display: 'flex', alignItems: 'center', width: 220, height: 32 }}>
        <MarqueeLabel hover text={TITLE} color={t.text} />
      </div>
    </div>
  )
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'Marquee lab', width: 320, height: 120, focus: false })
