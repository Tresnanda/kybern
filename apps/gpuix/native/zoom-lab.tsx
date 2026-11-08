import '../src/native/local-build.ts'
// The interface zoom lab (#292, zoom-check.ts). Commands arrive as automation keys on the root (`zoom:1.5`,
// `click:b3`, …); pointer commands become AppKit events at window points (content × zoom, zoom-input.m), so they enter
// GPUI through the platform path the zoom converts. `result` reports what the lab saw, published on a timer.
import { render, useGpuixRequired, type EventPayload } from '@gpuix/react'
import { dlopen, FFIType } from 'bun:ffi'
import { useEffect, useRef, useState } from 'react'
import { THEMES } from '../src/theme.ts'
import { Label, ThemeProvider } from '../src/ui.tsx'
import { getUiZoom, getUiZoomState, installUiZoom, setUiZoom, zoomIn, zoomOut } from '../src/shell/uiZoom.ts'
import { observeElementBounds } from '../src/native/layout.ts'
import { webHost } from '../src/native/webview.ts'

const TITLE = 'Zoom lab'
const MOVE = 0, DOWN = 1, UP = 2
// Off macOS there are no AppKit events; the check drives those parts through automation only.
const input = process.platform !== 'darwin' ? null : dlopen(new URL('./build/zoom-input.dylib', import.meta.url).pathname, {
  kybern_zoom_mouse: { args: [FFIType.cstring, FFIType.i32, FFIType.f64, FFIType.f64, FFIType.i32], returns: FFIType.void },
  kybern_zoom_drag: { args: [FFIType.cstring, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.i32], returns: FFIType.void },
  kybern_zoom_scroll: { args: [FFIType.cstring, FFIType.f64, FFIType.f64, FFIType.f64], returns: FFIType.void },
  kybern_zoom_sizes: { args: [FFIType.cstring], returns: FFIType.cstring },
  kybern_zoom_front: { args: [FFIType.cstring], returns: FFIType.void },
})?.symbols ?? null
const cstring = (text: string) => Buffer.from(`${text}\0`)
const title = cstring(TITLE)
const t = THEMES[process.env.KYBERN_APPEARANCE === 'light' ? 'light' : 'dark']
const BUTTONS = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']
const WEB = 'zoom-lab-web'

type Bounds = { x: number; y: number; width: number; height: number }

function Lab() {
  const renderer = useGpuixRequired() as ReturnType<typeof useGpuixRequired> & { getElementBounds?: (id: number) => Bounds | null; getSelectedText?: () => string | null }
  const seen = useRef({ hover: '', click: '', observed: 0 })
  const [hover, setHover] = useState('')
  const [pop, setPop] = useState(false)
  const [result, setResult] = useState('')
  const ids = useRef<Record<string, number>>({})
  const ref = (name: string) => (node: { id: number } | null) => { if (node) ids.current[name] = node.id }
  const center = (name: string) => {
    const b = ids.current[name] !== undefined ? renderer.getElementBounds?.(ids.current[name]) : null
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, b } : null
  }
  // Content pixels → window points.
  const os = (v: number) => v * getUiZoom()
  useEffect(() => {
    installUiZoom(renderer)
    const timer = setInterval(() => {
      const state = getUiZoomState()
      setResult(JSON.stringify({ zoom: state.zoom, display: state.display, sizes: input ? String(input.kybern_zoom_sizes(title)) : '', ...seen.current, selected: renderer.getSelectedText?.() ?? '' }))
    }, 50)
    return () => clearInterval(timer)
  }, [])
  // The layout observer a terminal resizes its PTY from reports content pixels.
  useEffect(() => {
    if (ids.current.observed === undefined) return
    return observeElementBounds(renderer, ids.current.observed, (event) => { if (event.rect) seen.current.observed = event.rect.width })
  }, [])
  // A web page placed over its slot (KYBERN_ZOOM_LAB_URL): it must cover the slot at every zoom and zoom with the UI.
  useEffect(() => {
    const url = process.env.KYBERN_ZOOM_LAB_URL
    if (!url || !webHost.available || ids.current.web === undefined) return
    const unsubscribe = webHost.subscribe((event) => { if (process.env.KYBERN_ZOOM_LAB_DEBUG) console.error('[zoom-lab web]', JSON.stringify(event)) })
    webHost.create(WEB, url, 'server')
    const off = observeElementBounds(renderer, ids.current.web, (event) => {
      if (event.rect) webHost.place(WEB, event.rect, event.clippedRect ?? event.rect, { width: event.rect.width, height: event.rect.height, scale: 1, left: 0, top: 0 })
    })
    return () => { off(); unsubscribe(); webHost.destroy(WEB) }
  }, [])
  const command = (key: string) => {
    const [op, arg, extra] = key.split(':')
    if (op === 'zoom') { setUiZoom(Number(arg)); return }
    if (op === 'in') { zoomIn(); return }
    if (op === 'out') { zoomOut(); return }
    if (op === 'reset') { seen.current = { ...seen.current, hover: '', click: '' }; return }
    if (op === 'pop') { setPop((v) => !v); return }
    if (op === 'front') { input?.kybern_zoom_front(title); return }
    const at = center(arg)
    if (!at || !input) return
    if (op === 'hover') input.kybern_zoom_mouse(title, MOVE, os(at.x), os(at.y), 0)
    if (op === 'click') { input.kybern_zoom_mouse(title, MOVE, os(at.x), os(at.y), 0); input.kybern_zoom_mouse(title, DOWN, os(at.x), os(at.y), 1); input.kybern_zoom_mouse(title, UP, os(at.x), os(at.y), 1) }
    if (op === 'scroll') input.kybern_zoom_scroll(title, os(at.x), os(at.y), Number(extra.replace(/^n/, '-')))
    if (op === 'select') input.kybern_zoom_drag(title, os(at.b.x + 1), os(at.y), os(at.b.x + at.b.width - 1), os(at.y), 12)
  }
  return <ThemeProvider>
    <div testId="ready" tabIndex={0} onKeyDown={(e: EventPayload) => { if (e.key) command(e.key) }}
      style={{ width: '100%', height: '100%', backgroundColor: t.surface, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {BUTTONS.map((id) => <div key={id} ref={ref(id)} testId={id}
          onMouseEnter={() => { seen.current.hover = id; setHover(id) }} onClick={() => { seen.current.click = id }}
          style={{ width: 72, height: 36, borderRadius: 8, borderWidth: 1, borderColor: t.text, backgroundColor: hover === id ? t.hover : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Label color={t.text} size={13} style={{ pointerEvents: 'none' }}>{id}</Label>
        </div>)}
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <div ref={ref('list')} testId="list" style={{ width: 220, height: 160, overflowY: 'scroll', borderWidth: 1, borderColor: t.border, display: 'flex', flexDirection: 'column' }}>
          {Array.from({ length: 30 }, (_, i) => <div key={i} testId={`item-${i}`} style={{ height: 32, flexShrink: 0, paddingLeft: 8, display: 'flex', alignItems: 'center' }}><Label color={t.text} size={13}>{`Item ${i}`}</Label></div>)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <text ref={ref('prose')} testId="prose" style={{ color: t.text, fontSize: 14, userSelect: 'text' }}>Alpha bravo charlie delta</text>
          <div ref={ref('pop')} testId="pop-trigger" style={{ width: 120, height: 32, borderRadius: 8, backgroundColor: t.hover, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Label color={t.text} size={13}>Popover</Label></div>
          {pop && <PopAt id={ids.current.pop} />}
          <div ref={ref('web')} testId="web-slot" style={{ width: 240, height: 100, borderRadius: 6, backgroundColor: '#ff00ff' }} />
        </div>
      </div>
      <div ref={ref('observed')} testId="observed" style={{ width: '100%', height: 12, backgroundColor: t.hover }} />
      <div testId="edge" style={{ width: 200, height: 20, borderTopWidth: 1, borderColor: '#000000', backgroundColor: '#ffffff' }} />
      <text testId="result" style={{ color: t.text, fontSize: 10 }}>{result}</text>
    </div>
  </ThemeProvider>
}

/** A popover anchored under the trigger, the way the kit's menus anchor in content coordinates. */
function PopAt({ id }: { id: number | undefined }) {
  const renderer = useGpuixRequired() as unknown as { getElementBounds?: (id: number) => Bounds | null }
  const b = id !== undefined ? renderer.getElementBounds?.(id) : null
  if (!b) return null
  return <anchored position={{ x: b.x, y: b.y + b.height + 4 }} anchor="topLeft" fit="snap" snapMargin={8} deferred priority={4}>
    <div testId="popover" style={{ width: 160, height: 60, borderRadius: 8, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border }} />
  </anchored>
}

render(<Lab />, { title: TITLE, width: 1000, height: 680, focus: false, minWidth: 900, minHeight: 600, titlebarTransparent: true })
