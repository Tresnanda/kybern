// The GPUIX kit gallery window: `KIT_SECTION=<name>` picks the section (`src/kit/gallery`). 1280 x 820, opaque,
// the desktop's `bg-background`, like `visual/kit/gallery.tsx` renders it.
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState, type ReactNode } from 'react'
import { gallery } from '../src/kit/gallery/index.tsx'
import { installFrameSource } from '../src/native/frame.ts'
import { ThemeProvider, useTheme } from '../src/ui.tsx'

function Ready({ children }: { children: ReactNode }) {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => { installFrameSource(renderer); setReady(true) }, [renderer])
  return ready ? children : null
}

function Frame() {
  const t = useTheme()
  const Section = gallery[process.env.KIT_SECTION ?? 'hello']
  return <div testId="app-ready" style={{ width: 1280, height: 820, position: 'relative', overflow: 'hidden', backgroundColor: t.v('--background') }}>{Section ? <Section /> : null}</div>
}

render(<ThemeProvider><Ready><Frame /></Ready></ThemeProvider>, {
  title: 'kit gallery',
  width: 1280,
  height: 820,
  windowBackground: 'opaque',
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
