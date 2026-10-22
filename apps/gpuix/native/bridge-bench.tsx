// ADE-52: cost of one synchronous window update from JS (macOS: same thread;
// Linux/Windows: the UI-thread bridge in patches/platforms_hooks.py).
//   bun native/bridge-bench.tsx
import '../src/native/local-build.ts'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect } from 'react'
function Bench() {
  const r = useGpuixRequired() as any
  useEffect(() => {
    setTimeout(() => {
      const time = (label: string, fn: () => unknown, n = 2000) => {
        for (let i = 0; i < 200; i++) fn()
        const samples: number[] = []
        for (let i = 0; i < n; i++) { const t = performance.now(); fn(); samples.push((performance.now() - t) * 1000) }
        samples.sort((a, b) => a - b)
        const q = (p: number) => samples[Math.floor(p * (samples.length - 1))]!.toFixed(1)
        console.log(`[bench] ${label}: p50 ${q(0.5)} us, p90 ${q(0.9)} us, p99 ${q(0.99)} us (n=${n})`)
      }
      time('isLayoutObserverActive (Kybern hook, update_window)', () => r.isLayoutObserverActive(1))
      time('getWindowSize (upstream query)', () => r.getWindowSize())
      time('getTextSelection (no window update)', () => r.getTextSelection())
      process.exit(0)
    }, 1500)
  }, [r])
  return <div style={{ width: '100%', height: '100%', backgroundColor: '#202024' }}><text style={{ color: '#fff' }}>bridge bench</text></div>
}
render(<Bench />, { title: 'bridge bench', width: 400, height: 300, focus: false })
