// motion10 lab: the app's success check (`t-success`: transform + stroke draw) and kit Checkbox (`t-check-path`), laid out
// like `motion10-webkit.mjs` (the desktop's motion CSS and markup in WebKit). Keys: s mounts the success check, r remounts
// everything. The checkbox animates on a real mouse click on `cb`.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { SuccessCheck } from '../src/motion/SuccessCheck.tsx'
import { Checkbox } from '../src/kit/Checkbox.tsx'

function Lab() {
  const t = useTheme()
  const [check, setCheck] = useState(0), [key, setKey] = useState(0)
  const action = (k: string) => {
    if (k === 's') setCheck(n => n + 1)
    if (k === 'r') setKey(n => n + 1)
  }
  return <div key={key} testId="app-ready" onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
    <div style={{ position: 'absolute', left: 24, top: 24, display: 'flex' }}><Checkbox testId="cb" aria-label="Done" /></div>
    <div style={{ position: 'absolute', left: 300, top: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 20, backgroundColor: t.v('--success') + '1f' }}>
      {check > 0 && <SuccessCheck key={check} testId="success-check" size={20} color={t.v('--success')} />}
    </div>
  </div>
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'motion10', width: 640, height: 320, focus: false })
