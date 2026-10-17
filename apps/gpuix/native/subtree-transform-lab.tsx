// Lab for `paintTransform` (subtree_transform.rs): a rounded, clipped, shadowed card with text, an SVG and a nested
// clip inside a transform scope; a pressable button; an unrelated cached island. Keys drive the scope (see `action`).
import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useEffect, useState } from 'react'
import type { Pointer } from 'bun:ffi'
import { each, getObjc, nsApp, sel } from '../src/native/objc.ts'
import { ICONS } from '../src/icons.tsx'
const light = process.env.KYBERN_APPEARANCE === 'light'
const fg = light ? '#202020' : '#eeeeee'
type Value = { scale?: number; rotate?: number; opacity?: number; translateX?: number; translateY?: number; blur?: number }
function Lab() {
  useEffect(() => { const o = getObjc(), app = nsApp(); if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, window => { o.msgSetI64(window, sel(o, 'setLevel:'), 3n); o.msgSetBool(window, sel(o, 'setIgnoresMouseEvents:'), true); o.msg(window, sel(o, 'orderFrontRegardless')) }) }, [])
  const [value, setValue] = useState<Value>({})
  const [duration, setDuration] = useState(0)
  const [tick, setTick] = useState(0), [clicks, setClicks] = useState(0), [pressClicks, setPressClicks] = useState(0)
  const action = (key: string) => {
    if (key === 's') setValue({ scale: 0.5 })
    if (key === 'r') setValue({ rotate: 90 })
    if (key === 'c') setValue({ scale: 0.8, rotate: 30, opacity: 0.6, translateX: 10 })
    if (key === 'b') setValue({ scale: 0.97, blur: 2, opacity: 0.5 })
    if (key === 'z') setValue({})
    if (key === 'a') setDuration(d => (d ? 0 : 0.4))
    if (key === 't') setTick(n => n + 1)
  }
  return <div testId="app-ready" onKeyDown={event => action(event.key ?? '')} style={{ width: '100%', height: '100%', backgroundColor: light ? '#f5f5f5' : '#202020' }}>
    <text testId="status" style={{ color: fg }}>{`Tick ${tick}; clicks ${clicks}; presses ${pressClicks}`}</text>
    <div testId="slot" style={{ position: 'absolute', left: 40, top: 60, width: 200, height: 160 }}>
      <div testId="scope" paintTransform={{ initial: false, animate: value, transition: { duration, ease: [0.23, 1, 0.32, 1] } }}
        style={{ width: 200, height: 160, overflow: 'hidden', borderRadius: 24, borderWidth: 2, borderColor: '#e0c060', backgroundColor: '#5070c0', boxShadow: { offsetX: 4, offsetY: 6, blurRadius: 10, spreadRadius: 0, color: 'rgba(0,0,0,.5)' } }}>
        <text style={{ color: '#ffffff', fontSize: 18, fontWeight: 600 }}>Transformed card</text>
        <svg source={ICONS.checklist} style={{ width: 32, height: 32, color: '#ffffff' }} />
        <div testId="inner-button" onClick={() => setClicks(n => n + 1)} style={{ position: 'absolute', left: 120, top: 100, width: 70, height: 50, overflow: 'hidden', borderRadius: 12, backgroundColor: '#b04060' }}>
          <div style={{ position: 'absolute', left: -10, top: -10, width: 40, height: 40, backgroundColor: '#40c080', pointerEvents: 'none' }} />
        </div>
      </div>
    </div>
    <div testId="press" onClick={() => setPressClicks(n => n + 1)} paintTransform={{ initial: false, animate: {}, press: { scale: 0.5, down: { duration: 0 }, up: { duration: 0 } } }}
      style={{ position: 'absolute', left: 300, top: 60, width: 120, height: 60, borderRadius: 10, backgroundColor: '#9070e0' }}>
      <text style={{ color: '#ffffff', pointerEvents: 'none' }}>Press me</text>
    </div>
    <div cache testId="unrelated" style={{ position: 'absolute', left: 300, top: 160, width: 160, height: 50, backgroundColor: '#307050' }}><text style={{ color: '#ffffff' }}>Unrelated island</text></div>
  </div>
}
render(<Lab />, { title: 'Subtree transform', width: 520, height: 300, focus: false })
