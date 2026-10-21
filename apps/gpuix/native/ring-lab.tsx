// Lab for ring-check.ts (N2: stroke_draw `from`/`to`/`retarget`): a 96 px ring at a value (`ringValue`), and the same value as
// its own arc path (`ringArc`, no motion) as the reference. Keys: 1/5/9 set 10/50/90 %, d remount drawing in, t re-render.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { ringArc, ringValue } from '../src/motion/success.ts'

function Lab() {
  const t = useTheme()
  const [value, setValue] = useState(0.25), [run, setRun] = useState(0), [tick, setTick] = useState(0)
  const ring = ringValue({ size: 24, radius: 10, strokeWidth: 2, fraction: value, drawIn: run > 0 })
  const plain = ringArc({ size: 24, radius: 10, strokeWidth: 2, fraction: value })
  const action = (k: string) => {
    if (k === '1') setValue(0.1)
    if (k === '5') setValue(0.5)
    if (k === '9') setValue(0.9)
    if (k === 'd') setRun(n => n + 1)
    if (k === 't') setTick(n => n + 1)
  }
  return <div testId="app-ready" onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
    <svg key={run} testId="ring" source={ring.source} {...(ring.paintAnimation ? { paintAnimation: ring.paintAnimation } : {})} style={{ position: 'absolute', left: 20, top: 20, width: 96, height: 96, color: t.text }} />
    <svg testId="plain" source={plain.source} style={{ position: 'absolute', left: 140, top: 20, width: 96, height: 96, color: t.text }} />
    <text style={{ position: 'absolute', left: 260, top: 60, fontSize: 12, color: t.textSecondary }}>{`Tick ${tick}`}</text>
  </div>
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'ring', width: 320, height: 140, focus: false })

const { each, getObjc, nsApp, sel } = await import('../src/native/objc.ts')
const objc = getObjc(), application = nsApp()
if (application) each(objc, objc.msg(application, sel(objc, 'windows')) as never, window => {
  objc.msgSetI64(window, sel(objc, 'setLevel:'), 3n)
  objc.msgSetBool(window, sel(objc, 'setIgnoresMouseEvents:'), true)
  objc.msg(window, sel(objc, 'orderFrontRegardless'))
})
