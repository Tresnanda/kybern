// Transcript motion lab: the scroll-to-bottom button toggled on demand (the
// automation wheel does not move the transcript's virtual list), driven by
// scripts/transcript-motion.ts `lab`.
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ScrollToBottom } from '../src/Transcript.tsx'
import { ThemeProvider, Label, useTheme } from '../src/ui.tsx'

function Lab() {
  const t = useTheme()
  const [visible, setVisible] = useState(false)
  return (
    <div testId="app-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface, padding: 24, position: 'relative' }}>
      <div testId="toggle" onClick={() => setVisible(!visible)} style={{ padding: 8, backgroundColor: t.buttonSecondary, borderRadius: 8, cursor: 'pointer', width: 160 }}>
        <Label color={t.text}>{visible ? 'Hide button' : 'Show button'}</Label>
      </div>
      <ScrollToBottom visible={visible} bottom={40} onClick={() => setVisible(false)} />
    </div>
  )
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'transcript-motion-lab', width: 360, height: 240, focus: process.env.GPUIX_BACKGROUND !== '1' })
