// The GPUIX kit gallery window: `KIT_SECTION=<name>` picks the section (`src/kit/gallery`). 1280 x 820, opaque,
// the desktop's `bg-background`, like `visual/kit/gallery.tsx` renders it.
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState, type ReactNode } from 'react'
import { gallery } from '../src/kit/gallery/index.tsx'
import { installFrameSource } from '../src/native/frame.ts'
import { ThemeProvider, useMaterial, useTheme } from '../src/ui.tsx'

function Ready({ children }: { children: ReactNode }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => { installFrameSource(renderer); setReady(true) }, [renderer])
  return ready ? children : null
}

/** `KIT_GLASS=1` (with `KYBERN_WINDOW_MATERIAL=window`): the window is glass, so the frame is the material's coat over a two-tone wallpaper, as the desktop would show through. */
const GLASS = process.env.KIT_GLASS === '1'

function Frame() {
  const t = useTheme()
  const m = useMaterial()
  const Section = gallery[process.env.KIT_SECTION ?? 'hello']
  return (
    <div testId="app-ready" style={{ width: 1280, height: 820, position: 'relative', overflow: 'hidden', backgroundColor: GLASS ? (t.variant === 'dark' ? '#1b2a3a' : '#c9d9ee') : t.v('--background') }}>
      {GLASS && <div style={{ position: 'absolute', left: 640, top: 0, width: 640, height: 820, backgroundColor: t.variant === 'dark' ? '#3a2a1b' : '#eed9c4' }} />}
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1280, height: 820, backgroundColor: GLASS ? m.content : undefined }}>{Section ? <Section /> : null}</div>
    </div>
  )
}

render(<ThemeProvider><Ready><Frame /></Ready></ThemeProvider>, {
  title: 'kit gallery',
  width: 1280,
  height: 820,
  windowBackground: GLASS ? 'blurred' : 'opaque',
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
