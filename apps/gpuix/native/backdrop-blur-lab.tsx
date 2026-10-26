// The scene backdrop filter on every renderer (WP9): Metal, wgpu (Linux) and Direct3D 11 (Windows). Driven by
// `backdrop-check.ts`; no daemon.
//
//   stripes        left half white/black, right half red/blue, 4 px each: what the filters blur
//   card           a frosted card (BACKDROP.frost: blur 16, saturation 1, radius 16) tinted blue, holding a sharp red bar
//   chain          a filter with no radius of its own inside a rounded `overflow: hidden` parent (the clip chain)
//   menu           a popup menu (BACKDROP.popup: blur 40, saturation 1.5, radius 12) over the red/blue stripes
//
// BACKDROP_LAB_BUSY=1 is the perf scene: transcript-like text rows over the stripes and a breathing dot that keeps
// GPUI drawing every frame; BACKDROP_LAB_SURFACES=0 leaves the card, chain and menu out (the baseline).
// BACKDROP_LAB_STATS=<file> writes frames drawn and process CPU over BACKDROP_LAB_SECONDS (default 4) after a 1.5 s
// warm-up, then shows testId `stats-done`.
import '../src/native/local-build.ts'
import '../src/native/backdrop.ts'
import { writeFileSync } from 'node:fs'
import { useEffect, useState } from 'react'
import { render, useGpuixRequired } from '@gpuix/react'
import { BACKDROP } from '../src/native/backdrop.ts'

const LAB = { width: 720, height: 480 }
const busy = process.env.BACKDROP_LAB_BUSY === '1'
const surfaces = process.env.BACKDROP_LAB_SURFACES !== '0'
const stripe = 4
const rows = Array.from({ length: 34 }, (_, i) => `${String(i + 1).padStart(2, '0')}  The assistant streamed a long paragraph of transcript text with code like \`frame.present()\` and more words.`)

type Stats = { getBridgeStats?: () => { drawnFrames?: number } | null }
function Measure({ file }: { file: string }) {
  const renderer = useGpuixRequired() as unknown as Stats
  const [done, setDone] = useState(false)
  useEffect(() => {
    const seconds = Number(process.env.BACKDROP_LAB_SECONDS ?? 4)
    const read = () => ({ frames: renderer.getBridgeStats?.()?.drawnFrames ?? null, cpu: process.cpuUsage(), at: performance.now() })
    const warm = setTimeout(() => {
      const before = read()
      setTimeout(() => {
        const after = read()
        const ms = after.at - before.at
        const cpuMs = (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000
        const frames = after.frames != null && before.frames != null ? after.frames - before.frames : null
        writeFileSync(file, JSON.stringify({ seconds: ms / 1000, frames, framesPerSecond: frames == null ? null : frames / (ms / 1000), cpuMsPerFrame: frames ? cpuMs / frames : null, processCpuPercent: cpuMs / ms * 100 }))
        setDone(true)
      }, seconds * 1000)
    }, 1500)
    return () => clearTimeout(warm)
  }, [])
  return done ? <div testId="stats-done" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1 }} /> : null
}

render(
  <div testId="ready" style={{ width: '100%', height: '100%', position: 'relative', backgroundColor: '#000000' }}>
    {process.env.BACKDROP_LAB_STATS && <Measure file={process.env.BACKDROP_LAB_STATS} />}
    {Array.from({ length: LAB.width / stripe }, (_, i) => {
      const left = i * stripe < LAB.width / 2
      const color = left ? (i % 2 ? '#000000' : '#ffffff') : (i % 2 ? '#0000ff' : '#ff0000')
      return <div key={i} style={{ position: 'absolute', left: i * stripe, top: 0, width: stripe, height: LAB.height, backgroundColor: color }} />
    })}
    {busy && <div style={{ position: 'absolute', left: 0, top: 0, width: LAB.width, height: LAB.height, display: 'flex', flexDirection: 'column', padding: 8, gap: 2 }}>
      {rows.map(row => <text key={row} style={{ color: '#e8e8ec', fontSize: 12, lineHeight: 12 }}>{row}</text>)}
      <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#9a9aa4' }} {...{ paintAnimation: { kind: 'breathe', cycleMs: 600 } }} />
    </div>}
    {surfaces && <>
      <div testId="card" backdrop={{ ...BACKDROP.frost }} style={{ position: 'absolute', left: 60, top: 60, width: 240, height: 180, borderRadius: 16, backgroundColor: 'rgba(40, 120, 220, 0.25)' }}>
        <div testId="sharp" style={{ position: 'absolute', left: 118, top: 40, width: 4, height: 100, backgroundColor: '#ff0000' }} />
      </div>
      <div testId="chain" style={{ position: 'absolute', left: 60, top: 290, width: 240, height: 140, borderRadius: 40, overflow: 'hidden' }}>
        <div backdrop={{ blur: 16, saturation: 1, radius: 0 }} style={{ width: 240, height: 140 }} />
      </div>
      <div testId="menu" backdrop={{ ...BACKDROP.popup, radius: 12 }} style={{ position: 'absolute', left: 420, top: 60, width: 240, height: 260, borderRadius: 12, backgroundColor: 'rgba(255, 255, 255, 0.10)', display: 'flex', flexDirection: 'column', padding: 12, gap: 8 }}>
        {['Copy', 'Paste', 'Fork from here', 'Delete'].map(item => <text key={item} style={{ color: '#ffffff', fontSize: 14 }}>{item}</text>)}
      </div>
    </>}
  </div>,
  { title: 'Backdrop blur', width: LAB.width, height: LAB.height, windowBackground: 'opaque', focus: false },
)
