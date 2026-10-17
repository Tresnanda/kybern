import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { setWindowCloseHandler } from '@gpuix/native/host'
import { useEffect, useState } from 'react'
import { each, getObjc, nsApp, sel } from '../src/native/objc.ts'
import type { Pointer } from 'bun:ffi'

function Lab() {
  const renderer = useGpuixRequired()
  const front = () => {
    renderer.activateWindow?.()
    const o = getObjc(); const app = nsApp(); if (!app) return
    each(o, o.msg(app, sel(o, 'windows')) as Pointer, window => {
      if (Number(o.msgU64(window, sel(o, 'isVisible'))) & 0xff) o.msg(window, sel(o, 'orderFrontRegardless'))
    })
  }
  const nativeClose = () => {
    const o = getObjc(); const app = nsApp(); if (!app) return
    each(o, o.msg(app, sel(o, 'windows')) as Pointer, window => {
      if (Number(o.msgU64(window, sel(o, 'isVisible'))) & 0xff) o.msgSetPtr(window, sel(o, 'performClose:'), null)
    })
  }
  const [keys, setKeys] = useState('')
  const [value, setValue] = useState('first\nsecond')
  const [submitted, setSubmitted] = useState(0)
  const [clicks, setClicks] = useState(0)
  const [closed, setClosed] = useState(0)
  const [allow, setAllow] = useState(false)
  const [reject, setReject] = useState(false)
  useEffect(() => setWindowCloseHandler(renderer, async () => {
    setClosed(n => n + 1)
    if (reject) throw new Error('Expected close rejection in native-check')
    return allow
  }), [renderer, allow, reject])
  return <div testId="app-ready" style={{ width: '100%', height: '100%', backgroundColor: '#202020', display: 'flex', flexDirection: 'column', gap: 0, padding: 0, color: '#eeeeee' }}>
    <div windowDrag testId="drag" style={{ width: '100%', height: 46, backgroundColor: '#333333' }}>
      <div testId="button" onClick={() => setClicks(n => n + 1)} style={{ width: 100, height: 30, backgroundColor: '#555555', pointerEvents: 'auto' }}><text>{`Clicks ${clicks}`}</text></div>
    </div>
    <div testId="below-titlebar" onClick={() => setClicks(n => n + 1)} style={{ width: 200, height: 24 }}><text>Just below titlebar</text></div>
    <textarea testId="editor" value={value} minRows={3} maxRows={5} interceptKeys={['up', 'down', 'enter', 'tab', 'escape']} onChange={e => setValue(e.value ?? '')} onSubmit={() => setSubmitted(n => n + 1)} onKeyDown={e => {
      setKeys(`${e.key}:${e.isHeld ? 'repeat' : 'press'}`)
      if (!e.modifiers?.shift) e.preventDefault()
    }} style={{ width: 400, color: '#ffffff', fontSize: 16 }} />
    <div testId="native-close" onClick={nativeClose} style={{ width: 200, height: 28 }}><text>Native close button</text></div>
    <div testId="front" onClick={front} style={{ width: 150, height: 28 }}><text>Raise lab window</text></div>
    <text testId="keys">{keys}</text>
    <text testId="value">{JSON.stringify(value)}</text>
    <text testId="submits">{`Submitted ${submitted}`}</text>
    <text testId="close-count">{`Close requests ${closed}`}</text>
    <div testId="reject-close" onClick={() => setReject(true)} style={{ width: 200, height: 28 }}><text>{reject ? 'Rejection enabled' : 'Reject close promise'}</text></div>
    <div testId="allow-close" onClick={() => { setReject(false); setAllow(true) }} style={{ width: 200, height: 40, backgroundColor: '#555555' }}><text>{allow ? 'Close allowed' : 'Allow close'}</text></div>
  </div>
}
render(<Lab />, { title: 'Native capability check', width: 640, height: 760, titlebarTransparent: true, focus: false })
