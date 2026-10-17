// Weight ladder for the system UI font (font_weight.rs): Labels and Markdown bold at the weights the app uses.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { FONT_UI } from '../src/theme.ts'
const light = process.env.KYBERN_APPEARANCE === 'light'
const fg = light ? '#0d0d0d' : '#fcfcfc'
const WEIGHTS = [400, 500, 510, 590, 600, 650, 700]
function Lab() {
  return <div testId="app-ready" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 16, width: '100%', height: '100%', backgroundColor: light ? '#ffffff' : '#181818' }}>
    {WEIGHTS.map(w => <text key={w} testId={`w-${w}`} style={{ color: fg, fontFamily: FONT_UI, fontSize: 14, lineHeight: 20, fontWeight: w, whiteSpace: 'nowrap', alignSelf: 'flex-start' }}>{`Weight ${w}: The quick brown fox jumps over the lazy dog`}</text>)}
    {WEIGHTS.map(w => <text key={`s${w}`} testId={`s-${w}`} style={{ color: fg, fontFamily: FONT_UI, fontSize: 12, lineHeight: 16, fontWeight: w, whiteSpace: 'nowrap', alignSelf: 'flex-start' }}>{`12px ${w}: Pending · Needs review · 3 tasks`}</text>)}
  </div>
}
render(<Lab />, { title: 'Font weights', width: 560, height: 420, focus: false })
