import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { writeFileSync } from 'node:fs'
import { MatrixLoader } from '../src/MatrixLoader.tsx'
import { MarqueeLabel } from '../src/sidebar/motion.tsx'
import { TokenTextarea } from '../src/composer/TokenTextarea.tsx'
import { installFrameSource } from '../src/native/frame.ts'
import { Label, useTheme } from '../src/ui.tsx'
import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { each, getObjc, nsApp, sel } from '../src/native/objc.ts'

const resize = dlopen('/usr/lib/libobjc.A.dylib', { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.f64], returns: FFIType.void } }).symbols.objc_msgSend
let expanded = false

function Row({ n }: { n: number }) {
  const [hover, setHover] = useState(false), t = useTheme()
  return <div testId={`row-${n}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    style={{ display: 'flex', alignItems: 'center', gap: 8, width: 260, height: 32, borderRadius: 8, backgroundColor: hover ? '#335588' : '#202020', paddingLeft: 8, paddingRight: 8 }}>
    <MatrixLoader />
    <MarqueeLabel hover={hover} text={`Conversation ${n}: a long chat title that scrolls while other conversations are running`} color={t.text} />
  </div>
}
function Lab() {
  const renderer = useGpuixRequired(), t = useTheme()
  const [ticks, setTicks] = useState(0), [clicks, setClicks] = useState(0), [value, setValue] = useState('')
  const editor = useRef(null), native = useRef(null)
  const maxPumpLateMs = useRef(0)
  const state = { ticks, clicks, value, maxPumpLateMs: maxPumpLateMs.current }
  useEffect(() => {
    installFrameSource(renderer)
    const timer = setInterval(() => setTicks(n => n + 1), 80)
    let last = performance.now()
    const probe = setInterval(() => { const now = performance.now(); maxPumpLateMs.current = Math.max(maxPumpLateMs.current, now - last - 20); last = now }, 20)
    return () => { clearInterval(timer); clearInterval(probe) }
  }, [renderer])
  useEffect(() => { writeFileSync(process.env.KYBERN_FREEZE_STATE!, JSON.stringify({ ...state, at: performance.now(), watchdog: (renderer as any).getFrameWatchdog?.() })) })
  return <div testId="app-ready" onKeyDown={e => {
    if (e.key !== 'f8') return
    expanded = !expanded
    const o = getObjc(), app = nsApp()
    if (app) each(o, o.msg(app, sel(o, 'windows')) as Pointer, window => resize(window, sel(o, 'setContentSize:'), expanded ? 820 : 800, expanded ? 570 : 550))
  }} style={{ display: 'flex', width: '100%', height: '100%', gap: 20, padding: 20, backgroundColor: '#101010' }}>
    <div cache="fill" style={{ display: 'flex', flexDirection: 'column', width: 260, height: 480 }}>
      {Array.from({ length: 12 }, (_, n) => <Row key={n} n={n} />)}
    </div>
    <div cache="fill" style={{ display: 'flex', flexDirection: 'column', width: 440, height: 480, gap: 16 }}>
      <div style={{ height: 90, flexShrink: 0, overflow: 'hidden' }}><Label color={t.text}>{`Streaming ${ticks}: ${'a live response '.repeat(ticks % 12 + 1)}`}</Label></div>
      <div testId="click" onClick={() => setClicks(n => n + 1)} style={{ width: 200, height: 60, backgroundColor: clicks % 2 ? '#30a040' : '#c03030' }}>
        <Label color="#ffffff">{`Click ${clicks}`}</Label>
      </div>
      <TokenTextarea testId="editor" value={value} references={[]} editorRef={editor} nativeRef={native} onChange={e => setValue(e.value ?? '')}
        style={{ width: 400, height: 120, color: '#ffffff', backgroundColor: '#303030', fontSize: 16 }} />
      <Label color={t.text}>{`Composer ${value}`}</Label>
    </div>
    {[clicks, value.length].map((number, bank) => <div key={bank} style={{ position: 'absolute', left: 320, top: 450 + bank * 20, display: 'flex', gap: 4 }}>
      {Array.from({ length: 8 }, (_, bit) => <div key={bit} testId={`state-${bank}-${bit}`} style={{ width: 12, height: 12, backgroundColor: number & (1 << bit) ? '#30a040' : '#c03030' }} />)}
    </div>)}
  </div>
}
render(<Lab />, { title: 'UI update regression check', width: 800, height: 550, focus: false })
