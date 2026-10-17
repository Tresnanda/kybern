// Frame cost of a near-empty 1280×820 window with one loader ticking, to
// separate GPUI's fixed per-frame cost from the app tree's.
//   bun scripts/frame-baseline.tsx [blurred|opaque]
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect } from 'react'
import { MatrixLoader } from '../src/MatrixLoader.tsx'
import { startPerfProbe } from '../src/perf/probe.ts'
import { ThemeProvider } from '../src/ui.tsx'

function App() {
  const renderer = useGpuixRequired()
  useEffect(() => startPerfProbe(renderer), [renderer])
  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: '#181818', alignItems: 'center', justifyContent: 'center' }}>
      <MatrixLoader cycle={1600} />
    </div>
  )
}
render(<ThemeProvider><App /></ThemeProvider>, {
  title: 'frame-baseline', width: 1280, height: 820, titlebarTransparent: true,
  windowBackground: process.argv[2] === 'opaque' ? 'opaque' : 'blurred', focus: false, debugFrameOverlay: 'minimal',
})
