// Every passive loop component, for perf/motion-fps/lab-check.ts: matrix loaders (four variants), the running task
// glyph, the connection spinner, the kit spinner and the live-label shimmer. Keys: H unmount, O cover the first
// loaders with a box painted after them, G shift the row 12 px, X write a compositor-layer probe to $MOTION_LAB_OUT/<n>.json.
import '../../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { MatrixLoader } from '../../src/MatrixLoader.tsx'
import { StatusGlyph } from '../../src/tasks/Glyphs.tsx'
import { Spinner as ConnectionSpinner } from '../../src/shell/Connection.tsx'
import { Spinner } from '../../src/kit/Spinner.tsx'
import { Shimmer } from '../../src/transcript/motion.tsx'
import { caProbe } from './ca-probe.ts'

const light = process.env.KYBERN_APPEARANCE === 'light', fg = light ? '#202020' : '#eeeeee'
let probes = 0
function Lab() {
  const [shown, setShown] = useState(true), [overlay, setOverlay] = useState(false), [moved, setMoved] = useState(false), [note, setNote] = useState('Ready')
  return <div testId="app-ready" onKeyDown={e => {
    if (e.key === 'h') setShown(v => !v)
    if (e.key === 'o') setOverlay(v => !v)
    if (e.key === 'g') setMoved(v => !v)
    if (e.key === 'x') { const n = ++probes; void caProbe(2200).then(result => { writeFileSync(path.join(process.env.MOTION_LAB_OUT!, `${n}.json`), JSON.stringify(result)); setNote(`Probe ${n}`) }) }
  }} style={{ width: '100%', height: '100%', padding: 24, display: 'flex', flexDirection: 'column', gap: 16, backgroundColor: light ? '#fafafa' : '#202020' }}>
    <text testId="note" style={{ color: fg }}>{note}</text>
    {shown && <div testId="loops" style={{ display: 'flex', alignItems: 'center', gap: 24, height: 40, marginLeft: moved ? 12 : 0 }}>
      {(['orbit', 'pulse', 'scan', 'twinkle'] as const).map(variant => <MatrixLoader key={variant} variant={variant} />)}
      <StatusGlyph status="running" />
      <ConnectionSpinner size={14} color={fg} />
      <Spinner size={16} color={fg} />
      <Shimmer text="Thinking" color={light ? 'rgba(30,30,30,.45)' : 'rgba(240,240,240,.58)'} />
    </div>}
    {overlay && <div testId="overlay" style={{ position: 'absolute', left: 24, top: 60, width: 100, height: 34, borderRadius: 8, backgroundColor: light ? '#ffffff' : '#303030' }} />}
  </div>
}
render(<Lab />, { title: 'Compositor loop verification', width: 640, height: 240, focus: false })
