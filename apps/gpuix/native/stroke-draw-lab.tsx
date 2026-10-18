// Lab for stroke-draw-check.ts: one 48 px check whose path strokes itself in (`paintAnimation: { kind: 'stroke' }`,
// stroke_draw.rs). Keys: d remount it drawing (`strokeDraw`, so Reduce Motion omits the prop), p show it plain (no prop),
// t re-render the window with an unrelated change.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { strokeDraw } from '../src/motion/success.ts'
import { N } from '../src/nav/glyphs.ts'

function Lab() {
  const t = useTheme()
  const [run, setRun] = useState(0), [plain, setPlain] = useState(false), [tick, setTick] = useState(0)
  const draw = strokeDraw(32, 150)
  const action = (k: string) => {
    if (k === 'd') { setPlain(false); setRun(n => n + 1) }
    if (k === 'p') setPlain(true)
    if (k === 't') setTick(n => n + 1)
  }
  return <div testId="app-ready" onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
    <div style={{ position: 'absolute', left: 40, top: 40, width: 48, height: 48, display: 'flex' }}>
      {run > 0 && <svg key={plain ? 'plain' : run} testId="glyph" source={N.check} {...(!plain && draw ? { paintAnimation: draw } : {})} style={{ width: 48, height: 48, color: t.text }} />}
    </div>
    <text style={{ position: 'absolute', left: 120, top: 50, fontSize: 12, color: t.textSecondary }}>{`Tick ${tick}`}</text>
  </div>
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'stroke draw', width: 320, height: 160, focus: false })
