/**
 * WP1 platform check: frame delivery, the JS loop's wakes, UI-thread bridge cost, scroll phase injection and repaint
 * under island invalidation, the same way on macOS, Linux (X11 or Wayland) and Windows.
 *
 *   bun scripts/frame-wake-check.tsx [--out result.json] [--expect-platform Wayland] [--expect-seat false] [--capture none]
 *
 * One small window, no daemon:
 * 1. Idle (3 s, nothing animates): off macOS the JS loop must not poll: at most ~15 ticks/s (the runtime's 100 ms
 *    fallback; it was 125/s on the 8 ms timer) and no JS wake (the native wake is the UI-exit wake only). macOS's display
 *    link wakes it every vsync while the window is on screen: recorded as a warning. Process CPU is recorded; over 25 % it warns on CI (Xvfb and WARP are not representative) and fails locally.
 * 2. Animate (2 s, one `onFrame` listener repaints every frame): `onFrame` delivers ≥ 10 frames/s from
 *    `subscribeAnimationFrames`; the loop's ticks are at least its wakes (both counted on the addon's prototype before
 *    the loop starts, so a wrapped renderer cannot read 0); off macOS the JS loop gets no per-frame wakes (≤ 2/s) and
 *    the bridge waits on the UI thread < 0.5 times per served frame. Served frames are split into drawn and
 *    callbacks-only.
 * 3. Scroll: `simulateScrollPhase` started / moved / ended moves a scroller.
 * 4. Repaint (`--capture none` skips it; Wayland has no grabber): three boxes alternate colour with a counter that an
 *    `onFrame` listener advances while a `paintAnimation` keeps GPUI drawing between batches, so a draw can land between
 *    `applyBatch` and the queued invalidation. Then two captures of the window as drawn (X server under Xvfb, the addon's
 *    `captureScreenshot(path, asDrawn)` elsewhere: no refresh, so a stale cached island stays stale) at both parities.
 *    `plain` is an ordinary box, `island` a leaf in a cached island (the scoped paint path), `nested` a leaf in a cached
 *    island whose parent changes in the same batch. Each must show the colour of `frame % 2`. Run it again with
 *    `KYBERN_FULL_INVALIDATE=1` (the runner's `frame-wake-full`) as the control.
 * 5. Exit (off macOS; macOS quits natively): `closeWindow()`; the UI-exit wake must reach the JS loop and end it.
 * Prints one `[frame-wake-check]` JSON line and exits 1 when a phase fails.
 */
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GpuixRenderer } from '@gpuix/native'
import { render, useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { installFrameSource, onFrame } from '../src/native/frame.ts'
import { near, parseXwininfoTree, pngPixels, tolerance } from '../native/check-harness.ts'

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const out = flag('out')
const expectPlatform = flag('expect-platform') ?? process.env.KYBERN_EXPECT_PLATFORM
const expectSeat = flag('expect-seat')
const captureMode = flag('capture') ?? 'png'
const bridged = process.platform !== 'darwin'
const ci = !!process.env.CI
const fullInvalidate = process.env.KYBERN_FULL_INVALIDATE === '1'

type Stats = {
  bridged: boolean; sent: number; waited: number; waitMs: number; servedFrames: number | null
  drawnFrames?: number | null; callbackFrames?: number | null; processServedFrames?: number | null; frameWakes: number; platform: string
}
type Info = { platform: string; scaleFactor: number; seat?: boolean | null; windows: { dpiMode: string; dpiSource?: string; windowDpi: number } | null }
type Probe = {
  getBridgeStats?(): Stats
  getPlatformInfo?(): Info
  getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null
  getScrollOffset(id: number): number[] | null
  simulateScrollPhase?(x: number, y: number, deltaX: number, deltaY: number, phase: string, modifiers?: string | null): void
  captureScreenshot?(path: string, asDrawn?: boolean): void
  closeWindow?(): void
}

// Count the JS loop's ticks and the wakes it receives on the prototype, before render() starts the loop.
const counts = { ticks: 0, wakes: 0, frames: 0 }
const proto = GpuixRenderer.prototype as unknown as { tick(): boolean; setFrameWakeCallback?(callback?: (() => void) | null): boolean }
const tick = proto.tick
proto.tick = function (this: unknown) { counts.ticks++; return tick.call(this) }
const setWake = proto.setFrameWakeCallback
if (setWake) proto.setFrameWakeCallback = function (this: unknown, callback?: (() => void) | null) {
  return setWake.call(this, callback ? () => { counts.wakes++; callback() } : callback)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const COLORS = {
  plain: ['#e84c42', '#3a87e9'],
  island: ['#f2c037', '#2fb36b'],
  nested: ['#f08a24', '#8e5bd8'],
  parent: ['#3b3b42', '#55555f'],
}
const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))

type Result = Record<string, unknown> & { failures: string[]; warnings: string[] }
let result: Result | undefined
const finish = (code?: number) => {
  if (!result) return
  result.ok = result.failures.length === 0
  console.log(`[frame-wake-check] ${JSON.stringify(result)}`)
  if (out) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2)) }
  realExit(code ?? (result.ok ? 0 : 1))
}
const realExit = process.exit.bind(process)

function Check() {
  const renderer = useGpuixRequired() as unknown as Probe
  const scroller = useRef<PublicInstance | null>(null)
  const boxes = { plain: useRef<PublicInstance | null>(null), island: useRef<PublicInstance | null>(null), nested: useRef<PublicInstance | null>(null) }
  const [frame, setFrame] = useState(0)
  const [animating, setAnimating] = useState(false)
  const [busy, setBusy] = useState(false)
  const frameRef = useRef(0)
  frameRef.current = frame

  useEffect(() => {
    installFrameSource(renderer)
    const stats = () => renderer.getBridgeStats?.() ?? null
    const cpu = () => {
      const usage = process.cpuUsage()
      return (usage.user + usage.system) / 1000
    }
    const measure = async (ms: number) => {
      const before = { stats: stats(), ...counts, cpu: cpu(), at: performance.now() }
      await sleep(ms)
      const after = { stats: stats(), ...counts, cpu: cpu(), at: performance.now() }
      const seconds = (after.at - before.at) / 1000
      const delta = (key: 'sent' | 'waited' | 'waitMs' | 'frameWakes' | 'servedFrames' | 'drawnFrames' | 'callbackFrames') => {
        const a = after.stats?.[key], b = before.stats?.[key]
        return a == null || b == null ? null : a - b
      }
      const frames = delta('servedFrames')
      const perFrame = (value: number | null) => (value == null || !frames ? null : value / frames)
      return {
        seconds,
        ticks: after.ticks - before.ticks,
        wakes: after.wakes - before.wakes,
        ticksPerSecond: (after.ticks - before.ticks) / seconds,
        wakesPerSecond: (after.wakes - before.wakes) / seconds,
        onFramePerSecond: (after.frames - before.frames) / seconds,
        servedFramesPerSecond: frames == null ? null : frames / seconds,
        drawnFrames: delta('drawnFrames'),
        callbackFrames: delta('callbackFrames'),
        sentPerFrame: perFrame(delta('sent')),
        waitedPerFrame: perFrame(delta('waited')),
        waitMsPerFrame: perFrame(delta('waitMs')),
        // Every thread of the process (GPUI's UI thread and renderer included).
        processCpuPercent: ((after.cpu - before.cpu) / (after.at - before.at)) * 100,
      }
    }

    const capture = async (file: string) => {
      if (process.platform === 'linux') {
        const windows = parseXwininfoTree(execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', timeout: 15_000 }))
        if (!windows[0]) throw new Error('no X window to capture')
        execFileSync('import', ['-window', windows[0].id, `PNG32:${file}`], { timeout: 30_000 })
      } else {
        if (!renderer.captureScreenshot) throw new Error('this addon has no captureScreenshot')
        renderer.captureScreenshot(file, true)
      }
      return pngPixels(file)
    }

    void (async () => {
      const failures: string[] = [], warnings: string[] = []
      result = { failures, warnings }
      await sleep(1500)
      const info = renderer.getPlatformInfo?.() ?? null
      const idle = await measure(3000)
      setAnimating(true)
      await sleep(300)
      const animate = await measure(2000)
      setAnimating(false)
      await sleep(300)

      const scroll: { before: number | null; after: number | null; error?: string } = { before: null, after: null }
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

      // Repaint: flip on every frame while GPUI also draws for the paint animation, settle, capture, flip once, capture.
      const repaint: Record<string, unknown> = { fullInvalidate }
      if (captureMode === 'none' || (process.platform === 'linux' && !process.env.DISPLAY)) repaint.skipped = 'no capture on this display'
      else {
        try {
          setBusy(true)
          setAnimating(true)
          await sleep(1000)
          setAnimating(false)
          const dir = out ? path.dirname(out) : path.join(tmpdir(), `frame-wake-${process.pid}`)
          mkdirSync(dir, { recursive: true })
          const scale = info?.scaleFactor ?? 1
          const shots: Record<string, unknown>[] = []
          for (let shot = 0; shot < 2; shot++) {
            if (shot) setFrame((n) => n + 1)
            await sleep(600)
            const parity = frameRef.current % 2
            const file = path.join(dir, `frame-wake-${parity ? 'odd' : 'even'}${fullInvalidate ? '-full' : ''}.png`)
            const png = await capture(file)
            const seen: Record<string, number[]> = {}
            for (const [name, ref] of Object.entries(boxes)) {
              const id = ref.current?.id, bounds = id == null ? null : renderer.getElementBounds(id)
              if (!bounds) { failures.push(`repaint: ${name} has no bounds`); continue }
              // `plain` holds its label at the left: sample its right edge, clear of glyph antialiasing.
              const x = name === 'plain' ? bounds.x + bounds.width - 6 : bounds.x + bounds.width / 2
              const pixel = png.at(x * scale, (bounds.y + bounds.height / 2) * scale)
              seen[name] = pixel
              const expected = rgb(COLORS[name as keyof typeof boxes][parity]!)
              if (!near(pixel, expected)) failures.push(`repaint: ${name} shows ${pixel} at frame ${frameRef.current}, expected ${expected} (stale${name === 'plain' ? '' : ' island'}?) in ${path.basename(file)}`)
            }
            shots.push({ frame: frameRef.current, parity, file: path.basename(file), seen })
          }
          repaint.shots = shots
          repaint.tolerance = tolerance
        } catch (error) {
          failures.push(`repaint: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
        } finally {
          setBusy(false)
        }
      }

      const stats_ = stats()
      const platform = info?.platform ?? stats_?.platform ?? 'unknown'
      if (expectPlatform && platform !== expectPlatform) failures.push(`platform is ${platform}, expected ${expectPlatform}`)
      if (expectSeat != null && String(info?.seat ?? null) !== expectSeat) failures.push(`seat is ${info?.seat ?? null}, expected ${expectSeat}`)
      // macOS: the display link wakes the loop every vsync while the window is on screen (tick pumps AppKit there);
      // recorded, not asserted. WP1's limits are for Linux and Windows.
      const idleLimit = bridged ? failures : warnings
      if (idle.ticksPerSecond > 15) idleLimit.push(`idle: ${idle.ticksPerSecond.toFixed(1)} JS ticks/s (polling)`)
      if (idle.wakesPerSecond > (bridged ? 0 : 5)) idleLimit.push(`idle: ${idle.wakesPerSecond.toFixed(1)} JS frame wakes/s`)
      if (idle.processCpuPercent > 25) (ci ? warnings : failures).push(`idle: process CPU ${idle.processCpuPercent.toFixed(0)} %`)
      if (animate.onFramePerSecond < 10) failures.push(`animate: ${animate.onFramePerSecond.toFixed(1)} onFrame deliveries/s`)
      if (animate.ticks < animate.wakes || animate.ticksPerSecond < 3) failures.push(`animate: ${animate.ticks} JS ticks for ${animate.wakes} wakes (the tick counter is not seeing the loop)`)
      if (bridged && animate.wakesPerSecond > 2) failures.push(`animate: ${animate.wakesPerSecond.toFixed(1)} JS frame wakes/s (per-frame wakes off macOS)`)
      if (animate.waitedPerFrame != null && animate.waitedPerFrame >= 0.5) failures.push(`animate: ${animate.waitedPerFrame.toFixed(2)} waiting bridge calls per frame`)
      if (scroll.error || scroll.before == null || scroll.after == null || scroll.after === scroll.before) failures.push(`scroll phases did not move the scroller (${scroll.error ?? `${scroll.before} -> ${scroll.after}`})`)
      if (info?.windows) {
        const { dpiMode, windowDpi } = info.windows
        if (!dpiMode.endsWith('per-monitor-v2')) failures.push(`windows: dpiMode is ${dpiMode}, expected a per-monitor-v2 mode`)
        if (!(windowDpi > 0)) failures.push(`windows: windowDpi is ${windowDpi}`)
        else if (Math.abs(info.scaleFactor - windowDpi / 96) > 0.01) failures.push(`windows: scaleFactor ${info.scaleFactor} disagrees with windowDpi ${windowDpi} / 96`)
      }
      Object.assign(result, { platform, info, idle, animate, scroll, repaint, bridge: stats_ })

      // Exit: the UI-exit wake (off macOS) must end the JS loop; render()'s loop then calls process.exit.
      const exit: Record<string, unknown> = {}
      result.exit = exit
      // macOS: closing the last window quits through AppKit, which ends the process before JavaScript runs again.
      if (!bridged) { exit.skipped = 'macOS quits natively'; return finish() }
      if (!renderer.closeWindow) {
        failures.push('exit: this addon has no closeWindow')
        return finish()
      }
      const wakesBefore = counts.wakes, closedAt = performance.now()
      process.exit = ((code?: number) => {
        exit.wakes = counts.wakes - wakesBefore
        exit.ms = performance.now() - closedAt
        if (bridged && (exit.wakes as number) < 1) failures.push('exit: the UI-exit wake never reached the JS loop (it ended on the fallback timer)')
        finish(code && code !== 0 ? code : undefined)
      }) as typeof process.exit
      setTimeout(() => { failures.push('exit: the JS loop did not end within 5 s of closeWindow'); finish() }, 5000)
      renderer.closeWindow()
    })()
  }, [renderer])

  useEffect(() => (animating ? onFrame(() => { counts.frames++; setFrame((n) => n + 1) }) : undefined), [animating])

  const parity = frame % 2
  return (
    <div testId="ready" style={{ width: '100%', height: '100%', backgroundColor: '#202024', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <div ref={boxes.plain} style={{ width: 120, height: 24, backgroundColor: COLORS.plain[parity] }}>
          <text style={{ color: '#ffffff' }}>{`frame ${frame}`}</text>
        </div>
        <div cache style={{ width: 40, height: 24 }}>
          <div ref={boxes.island} style={{ width: 40, height: 24, backgroundColor: COLORS.island[parity] }} />
        </div>
        <div style={{ width: 56, height: 32, padding: 4, backgroundColor: COLORS.parent[parity], borderRadius: parity ? 2 : 6 }}>
          <div cache style={{ width: 48, height: 24 }}>
            <div ref={boxes.nested} style={{ width: 48, height: 24, backgroundColor: COLORS.nested[parity] }} />
          </div>
        </div>
        {/* Keeps GPUI drawing every frame (no batches) while the repaint phase flips colours. */}
        {busy ? <div style={{ width: 16, height: 16, backgroundColor: '#9a9aa4' }} {...{ paintAnimation: { kind: 'breathe', cycleMs: 600 } }} /> : null}
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
