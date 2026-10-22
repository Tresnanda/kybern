// Native `edgeFade` (N3) on a transparent window: every case is opaque content,
// so the captured alpha is the fade itself. edge-fade-check.ts samples it.
import '../src/native/local-build.ts'
import '../src/native/backdrop.ts'
import { render, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useRef, useState } from 'react'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="200"><path fill="#3a87e9" d="M0 0H60V200H0Z"/></svg>'
const image = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
const text = Array.from({ length: 5 }, () => 'M').join('\n')
function Columns() {
  return <>
    <div testId="quad" style={{ position: 'absolute', left: 0, top: 0, width: 60, height: 200, backgroundColor: '#e84c42' }} />
    <img src={image} style={{ position: 'absolute', left: 70, top: 0, width: 60, height: 200 }} />
    <text style={{ position: 'absolute', left: 140, top: 0, width: 60, color: '#38bc87', fontSize: 34, lineHeight: 40, fontWeight: 900, }}>{text}</text>
  </>
}
const Fill = ({ color = '#e84c42' }: { color?: string }) => <div style={{ width: '100%', height: '100%', backgroundColor: color }} />
function Lab() {
  const renderer = useGpuixRequired() as unknown as { setSubtreeTranslation?: (id: number, t: { translateX: number; translateY: number }) => void }
  const mover = useRef<PublicInstance | null>(null), [hit, setHit] = useState('none')
  return <div testId="app-ready" onKeyDown={e => { if ((e.key === 's' || e.key === 'u') && mover.current) renderer.setSubtreeTranslation?.(mover.current.id, { translateX: 0, translateY: e.key === 's' ? -60 : 0 }) }} style={{ width: '100%', height: '100%' }}>
    <div testId="fade" onClick={() => setHit('fade')} edgeFade={{ bottom: 40 }} style={{ position: 'absolute', left: 20, top: 20, width: 200, height: 200 }}><Columns /></div>
    <div testId="reference" style={{ position: 'absolute', left: 240, top: 20, width: 200, height: 200 }}><Columns /></div>
    <div testId="nested" edgeFade={{ bottom: 40 }} style={{ position: 'absolute', left: 460, top: 20, width: 200, height: 200 }}>
      <div edgeFade={{ bottom: 40 }} style={{ width: 200, height: 200 }}><Fill /></div>
    </div>
    <div testId="inset" edgeFade={{ bottom: 20, insetBottom: 30 }} style={{ position: 'absolute', left: 20, top: 260, width: 200, height: 120 }}><Fill /></div>
    <div testId="scroller" edgeFade={{ bottom: 40 }} style={{ position: 'absolute', left: 240, top: 260, width: 200, height: 160, overflowY: 'scroll', display: 'flex', flexDirection: 'column' }}>
      {Array.from({ length: 12 }, (_, i) => <div key={i} style={{ width: 200, height: 50, flexShrink: 0, backgroundColor: i % 2 ? '#3a87e9' : '#e84c42' }} />)}
    </div>
    <div style={{ position: 'absolute', left: 460, top: 260, width: 200, height: 200, overflow: 'hidden' }}>
      <div ref={mover} testId="mover" paintTranslate={{ initial: false, animate: { translateX: 0, translateY: 0 }, transition: { duration: 0 } }} style={{ position: 'absolute', left: 0, top: 0, width: 200, height: 200 }}>
        <div testId="row" edgeFade={{ bottom: 40 }} style={{ position: 'absolute', left: 0, top: 80, width: 200, height: 100 }}><Fill color="#38bc87" /></div>
      </div>
    </div>
    <div testId="left" edgeFade={{ left: 40, top: 20 }} style={{ position: 'absolute', left: 20, top: 440, width: 160, height: 100 }}><Fill /></div>
    <text testId="hit" style={{ position: 'absolute', left: 240, top: 440, color: '#e2e2e2' }}>{hit}</text>
  </div>
}
render(<Lab />, { title: 'Edge fade', width: 680, height: 560, windowBackground: 'transparent', titlebarTransparent: true, focus: false })
