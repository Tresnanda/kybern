/**
 * WP1 platform check: native frame wakes, UI-thread bridge cost and scroll
 * phase injection, the same way on macOS, Linux (X11 or Wayland) and Windows.
 *
 *   bun scripts/frame-wake-check.tsx [--out result.json] [--expect-platform Wayland]
 *
 * Three phases in one small window, no daemon:
 * 1. Idle (3 s, nothing animates): the JS frame loop must not poll. It ticks on
 *    native frame wakes plus the runtime's 100 ms fallback, so at most ~15
 *    ticks/s (it was 125/s off macOS on the 8 ms timer).
 * 2. Animate (2 s, one `onFrame` listener repaints every frame): frames are
 *    paced natively and wake JS; off macOS each frame's bridge traffic is
 *    counted and must not wait on the UI thread (`waited` per frame < 0.5).
 * 3. Scroll: `simulateScrollPhase` started / moved / ended moves a scroller,
 *    which used to be macOS-only.
 * Prints one `[frame-wake-check]` JSON line and exits 1 when a phase fails.
 */
import '../src/native/local-build.ts'
import { writeFileSync } from 'node:fs'
import { render, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { installFrameSource, onFrame } from '../src/native/frame.ts'

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const out = flag('out')
const expectPlatform = flag('expect-platform') ?? process.env.KYBERN_EXPECT_PLATFORM

type Stats = { bridged: boolean; sent: number; waited: number; waitMs: number; servedFrames: number | null; frameWakes: number; platform: string }
type Probe = {
  tick(): boolean
  getBridgeStats?(): Stats
  getPlatformInfo?(): { platform: string; scaleFactor: number; windows: { dpiMode: string; windowDpi: number } | null }
  getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null
  getScrollOffset(id: number): number[] | null
  simulateScrollPhase?(x: number, y: number, deltaX: number, deltaY: number, phase: string, modifiers?: string | null): void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function Check() {
  const renderer = useGpuixRequired() as unknown as Probe
  const scroller = useRef<PublicInstance | null>(null)
  const [frame, setFrame] = useState(0)
  const [animating, setAnimating] = useState(false)

  useEffect(() => {
    installFrameSource(renderer)
    let ticks = 0
    const tick = renderer.tick.bind(renderer)
    renderer.tick = () => {
      ticks++
      return tick()
    }
    const stats = () => renderer.getBridgeStats?.() ?? null
    const cpu = () => {
      const usage = process.cpuUsage()
      return (usage.user + usage.system) / 1000
    }
    const measure = async (ms: number) => {
      const before = { stats: stats(), ticks, cpu: cpu(), at: performance.now() }
      await sleep(ms)
      const after = { stats: stats(), ticks, cpu: cpu(), at: performance.now() }
      const seconds = (after.at - before.at) / 1000
      const delta = (key: 'sent' | 'waited' | 'waitMs' | 'frameWakes') => (after.stats && before.stats ? after.stats[key] - before.stats[key] : null)
      const frames = after.stats?.servedFrames != null && before.stats?.servedFrames != null ? after.stats.servedFrames - before.stats.servedFrames : null
      const perFrame = (value: number | null) => (value == null || !frames ? null : value / frames)
      return {
        seconds,
        ticksPerSecond: (after.ticks - before.ticks) / seconds,
        frameWakesPerSecond: delta('frameWakes') == null ? null : delta('frameWakes')! / seconds,
        servedFramesPerSecond: frames == null ? null : frames / seconds,
        sentPerFrame: perFrame(delta('sent')),
        waitedPerFrame: perFrame(delta('waited')),
        waitMsPerFrame: perFrame(delta('waitMs')),
        // Every thread of the process (GPUI's UI thread and renderer included).
        processCpuPercent: ((after.cpu - before.cpu) / (after.at - before.at)) * 100,
      }
    }

    void (async () => {
      const failures: string[] = []
      await sleep(1500)
      const info = renderer.getPlatformInfo?.() ?? null
      const idle = await measure(3000)
      setAnimating(true)
      await sleep(300)
      const animate = await measure(2000)
      setAnimating(false)
      await sleep(300)

      let scroll: { before: number | null; after: number | null; error?: string } = { before: null, after: null }
      try {
        const id = scroller.current?.id
        const bounds = id == null ? null : renderer.getElementBounds(id)
        if (id == null) throw new Error('the scroller has no element id')
        if (!bounds) throw new Error('the scroller has no layout yet (nothing painted)')
        if (!renderer.simulateScrollPhase) throw new Error('this addon has no simulateScrollPhase')
        const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
        scroll.before = renderer.getScrollOffset(id)?.[1] ?? null
        renderer.simulateScrollPhase(x, y, 0, 0, 'started')
        for (let i = 0; i < 5; i++) renderer.simulateScrollPhase(x, y, 0, -40, 'moved')
        renderer.simulateScrollPhase(x, y, 0, 0, 'ended')
        await sleep(300)
        scroll.after = renderer.getScrollOffset(id)?.[1] ?? null
      } catch (error) {
        scroll.error = String(error)
      }

      const platform = info?.platform ?? renderer.getBridgeStats?.()?.platform ?? 'unknown'
      if (expectPlatform && platform !== expectPlatform) failures.push(`platform is ${platform}, expected ${expectPlatform}`)
      if (idle.ticksPerSecond > 15) failures.push(`idle: ${idle.ticksPerSecond.toFixed(1)} JS ticks/s (polling)`)
      if (idle.frameWakesPerSecond != null && idle.frameWakesPerSecond > 5) failures.push(`idle: ${idle.frameWakesPerSecond.toFixed(1)} frame wakes/s`)
      if (animate.frameWakesPerSecond == null || animate.frameWakesPerSecond < 10) failures.push(`animate: ${animate.frameWakesPerSecond?.toFixed(1) ?? 'no'} frame wakes/s`)
      if (animate.waitedPerFrame != null && animate.waitedPerFrame >= 0.5) failures.push(`animate: ${animate.waitedPerFrame.toFixed(2)} waiting bridge calls per frame`)
      if (scroll.error || scroll.before == null || scroll.after == null || scroll.after === scroll.before) failures.push(`scroll phases did not move the scroller (${scroll.error ?? `${scroll.before} -> ${scroll.after}`})`)

      const result = { platform, info, idle, animate, scroll, failures, ok: failures.length === 0 }
      console.log(`[frame-wake-check] ${JSON.stringify(result)}`)
      if (out) writeFileSync(out, JSON.stringify(result, null, 2))
      process.exit(result.ok ? 0 : 1)
    })()
  }, [renderer])

  useEffect(() => (animating ? onFrame(() => setFrame((n) => n + 1)) : undefined), [animating])

  return (
    <div testId="ready" style={{ width: '100%', height: '100%', backgroundColor: '#202024', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 120, height: 24, backgroundColor: frame % 2 ? '#3a87e9' : '#e84c42' }}>
        <text style={{ color: '#ffffff' }}>{`frame ${frame}`}</text>
      </div>
      <div ref={scroller} style={{ width: 240, height: 120, overflowY: 'scroll', backgroundColor: '#2c2c31' }}>
        {Array.from({ length: 40 }, (_, row) => (
          <text key={row} style={{ color: '#ffffff', height: 20 }}>{`row ${row}`}</text>
        ))}
      </div>
    </div>
  )
}

render(<Check />, { title: 'frame wake check', width: 400, height: 260, focus: false })
