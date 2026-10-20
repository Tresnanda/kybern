// Lab for hover-fade-check.ts (N1, hover_fade_*): 48 px boxes whose `hover` / `active` colours ease natively. The root
// declares `hoverTransition` (KYBERN_HOVER_FADE=0 leaves it off, the snap control). Boxes: `wash` transparent → wash,
// `solid` one fill to another plus a border colour, `scoped` the same inside a retained `paintTransform` (opacity .6),
// `optout` with `hoverTransition={false}` (snaps), `state` a rest fill flipped by the `s` key (instant), `press` an
// `active` fill (lands at once on mouse down, eases back on release). `t` re-renders the window.
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { ThemeProvider, useTheme } from '../src/ui.tsx'
import { HOVER_FADE_ROOT } from '../src/motion/kit.tsx'

const BOX = { position: 'absolute', top: 40, width: 48, height: 48, borderRadius: 8 } as const

function Lab() {
  const t = useTheme()
  const dark = t.variant === 'dark'
  const [flip, setFlip] = useState(false), [tick, setTick] = useState(0)
  const wash = dark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(0, 0, 0, 0.6)'
  const action = (k: string) => {
    if (k === 's') setFlip(f => !f)
    if (k === 't') setTick(n => n + 1)
  }
  return <div testId="app-ready" {...HOVER_FADE_ROOT} onKeyDown={e => action(e.key ?? '')} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: t.v('--background') }}>
    <div testId="wash" style={{ ...BOX, left: 20, hover: { backgroundColor: wash } }} />
    <div testId="solid" style={{ ...BOX, left: 84, backgroundColor: '#d03030', borderWidth: 4, borderColor: '#30d030', hover: { backgroundColor: '#3050e0', borderColor: '#f0f040' } }} />
    <div paintTransform={{ initial: false, animate: { opacity: 0.6 }, retain: true }} style={{ ...BOX, left: 148, display: 'flex' }}>
      <div testId="scoped" style={{ width: 48, height: 48, borderRadius: 8, backgroundColor: '#d03030', hover: { backgroundColor: '#3050e0' } }} />
    </div>
    <div testId="optout" hoverTransition={false} style={{ ...BOX, left: 212, backgroundColor: '#d03030', hover: { backgroundColor: '#3050e0' } }} />
    <div testId="state" style={{ ...BOX, left: 276, backgroundColor: flip ? '#3050e0' : '#d03030', hover: { borderColor: '#000000' } }} />
    <div testId="press" style={{ ...BOX, left: 340, backgroundColor: '#d03030', active: { backgroundColor: '#3050e0' } }} />
    <text style={{ position: 'absolute', left: 20, top: 110, fontSize: 12, color: t.textSecondary }}>{`Tick ${tick}`}</text>
  </div>
}
render(<ThemeProvider><Lab /></ThemeProvider>, { title: 'hover fade', width: 420, height: 140, focus: false })

// OS captures require this owned window to remain visible while the test runs.
const { each, getObjc, nsApp, sel } = await import('../src/native/objc.ts')
const objc = getObjc(), application = nsApp()
if (application) each(objc, objc.msg(application, sel(objc, 'windows')) as never, window => {
  objc.msgSetI64(window, sel(objc, 'setLevel:'), 3n)
  objc.msgSetBool(window, sel(objc, 'setIgnoresMouseEvents:'), true)
  objc.msg(window, sel(objc, 'orderFrontRegardless'))
})
