import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { THEMES } from '../src/theme.ts'
import { ThemeProvider } from '../src/ui.tsx'
import { ImageViewer } from '../src/motion/ImageMorph.tsx'

// Tab navigation is the window default in GPUIX 0.11. Three plain tab stops, one that
// consumes Tab itself (the terminal, an editor action) and an open image preview, which
// traps Tab with focusNextWithin and must stop the window default doing it a second time.
const t = THEMES.dark
const image = new URL('../../desktop/src-tauri/icons/128x128@2x.png', import.meta.url).pathname

function Lab() {
  const renderer = useGpuixRequired()
  const [focus, setFocus] = useState('none')
  const [open, setOpen] = useState(false)
  const refs = useRef(new Map<string, { id: number } | null>())
  // A window in the background gets no focus events, so read the focused element from the renderer.
  useEffect(() => {
    const timer = setInterval(() => {
      const id = renderer.getFocusedElementId?.() ?? null
      const name = [...refs.current].find(([, node]) => node?.id === id)?.[0]
      setFocus(name ?? (id == null ? 'none' : 'other'))
    }, 20)
    return () => clearInterval(timer)
  }, [renderer])
  const stop = (name: string, extra: Record<string, unknown> = {}) => (
    <div key={name} ref={(node: { id: number } | null) => { refs.current.set(name, node) }} testId={`stop-${name}`} tabIndex={0}
      style={{ width: 120, height: 32, borderRadius: 8, backgroundColor: focus === name ? t.hover : t.sidebar }} {...extra}>
      <text style={{ color: t.text, fontSize: 13 }}>{name}</text>
    </div>
  )
  return <ThemeProvider>
    <div testId="ready" style={{ width: '100%', height: '100%', backgroundColor: t.surface, padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <text testId="focus" style={{ color: t.text, fontSize: 14 }}>{focus}</text>
      {stop('a')}
      {stop('b')}
      {stop('consume', { onKeyDown: (e: { key?: string; preventDefault(): void }) => { if (e.key === 'tab') e.preventDefault() } })}
      {stop('c')}
      <div testId="open" ref={(node: { id: number } | null) => { refs.current.set('open', node) }} tabIndex={0} onClick={() => setOpen(true)} style={{ width: 120, height: 32 }}><text style={{ color: t.text, fontSize: 13 }}>Open preview</text></div>
      {open && <ImageViewer testId="viewer" src={image} label="icon.png" from={null} source={() => null} onClose={() => setOpen(false)} />}
    </div>
  </ThemeProvider>
}
render(<Lab />, { title: 'Tab navigation', width: 640, height: 480, focus: false })
