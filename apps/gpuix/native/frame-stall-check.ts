import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'

// Frame watchdog (gpui_macos window.rs, macOS). The lab window redraws 20 times a
// second while `KYBERN_FRAME_STALL_TEST` puts it into each stalled state the
// watchdog repairs: a display link that stopped calling back (`silent-link`), one
// only a new link revives (`dead-link`), a window left unsubscribed
// (`unsubscribe`), and a draw that got no drawable (`drop-drawable`). With
// `KYBERN_FRAME_WATCHDOG=log` (the old behaviour, reported) a stalled window stays
// frozen; with the watchdog on, frames come back within a few hundred ms. Run it
// with the hidden test display up (perf/test-display) so the window stays off
// the screen in use. `starve-drawables` (the compositor showing no drawable) is
// checked with the drawable gate off and on.
type Report = { frames: number; stalls: number; repairs: number; droppedFrames: number; representedFrames: number; slowDrawables: number; drawableStarvations: number; drawableRecoveries: number; starvedSkips: number; drawableKicks: number; lastStarvation: string | null; labGaps: number; labMaxGapMs: number; labStalledMs: number; labMaxLateMs: number; labBlocks: number }

async function run(env: Record<string, string>, seconds: number, during?: (lines: () => string[]) => Promise<void>) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-frame-stall-'))
  let text = ''
  const f = await launchFixture(path.join(import.meta.dir, 'frame-stall-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_NO_ACTIVATE: '1', KYBERN_DATA_DIR: scratch, KYBERN_URL: '', ...env }, { stderr: chunk => { text += chunk } })
  const lines = () => text.split('\n').filter(line => line.startsWith('[frame-stall-lab]'))
  try {
    await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 30_000 })
    if (during) await during(lines)
    else await Bun.sleep(seconds * 1000)
    const reports = lines().filter(line => line.includes('{')).map(line => JSON.parse(line.slice(line.indexOf('{'))) as Report)
    assert.ok(reports.length, `no reports: ${f.diagnostics()}`)
    return { last: reports.at(-1)!, maxGap: Math.max(...reports.slice(1).map(r => r.labMaxGapMs)), maxLate: Math.max(...reports.slice(1).map(r => r.labMaxLateMs)), lines }
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}

const failures: string[] = []
const expect = (name: string, ok: boolean, detail: string) => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`
  console.log(line)
  if (!ok) failures.push(line)
}

{
  const { last } = await run({}, 8)
  expect('no fault: no stall or starvation reported', last.stalls === 0 && last.labGaps === 0 && last.drawableStarvations === 0 && last.starvedSkips === 0,
    `stalls ${last.stalls}, gaps ${last.labGaps}, starvations ${last.drawableStarvations}, skipped draws ${last.starvedSkips}`)
}
for (const fault of ['silent-link', 'unsubscribe']) {
  const before = await run({ KYBERN_FRAME_WATCHDOG: 'log', KYBERN_FRAME_STALL_TEST: `${fault}:1500` }, 6)
  expect(`${fault}, watchdog only reporting: stays frozen`, before.last.labStalledMs > 3000 && before.last.repairs === 0, `${before.last.labStalledMs} ms without frames, ${before.last.stalls} stalls reported`)
  const after = await run({ KYBERN_FRAME_STALL_TEST: `${fault}:1500` }, 12)
  expect(`${fault}, watchdog on: every stall repaired`, after.last.stalls >= 5 && after.last.repairs === after.last.stalls && after.last.labGaps === after.last.stalls && after.maxGap < 700,
    `${after.last.repairs}/${after.last.stalls} repaired, ${after.last.labGaps} gaps, longest ${after.maxGap} ms`)
}
{
  const after = await run({ KYBERN_FRAME_STALL_TEST: 'dead-link:3000' }, 12)
  expect('dead-link, watchdog on: the link is replaced', after.last.labGaps >= 3 && after.maxGap < 1300, `${after.last.labGaps} gaps, longest ${after.maxGap} ms, ${after.last.stalls} stall reports`)
}

// Drawable starvation (gpui_apple drawable_gate.rs): the compositor shows none of
// the presented drawables, as in the field after the display slept, so every
// nextDrawable waits about a second. `starve-drawables:5000` emulates that for 3 s
// after every 5 s of normal drawing. Without the gate the main thread (and with it JS) blocks for a second
// per draw; with it, draws are skipped instead and each episode ends once the
// compositor shows drawables again.
{
  const before = await run({ KYBERN_DRAWABLE_GATE: '0', KYBERN_FRAME_STALL_TEST: 'starve-drawables:5000' }, 17)
  expect('starve-drawables, gate off: the main thread blocks in nextDrawable', before.maxLate > 900 && before.last.labBlocks >= 2 && before.last.drawableStarvations === 0,
    `${before.last.labBlocks} blocks over 200 ms, longest ${before.maxLate} ms late, ${before.last.slowDrawables} slow drawables`)
  const after = await run({ KYBERN_FRAME_STALL_TEST: 'starve-drawables:5000' }, 17)
  expect('starve-drawables, gate on: no block, every episode ends', after.maxLate < 250 && after.last.labBlocks === 0 && after.last.drawableStarvations >= 2 && after.last.drawableRecoveries >= after.last.drawableStarvations - 1 && after.last.starvedSkips > 0,
    `${after.last.labBlocks} blocks, longest ${after.maxLate} ms late, ${after.last.drawableStarvations} episodes, ${after.last.drawableRecoveries} ended, ${after.last.starvedSkips} draws skipped, ${after.last.drawableKicks} kicks, ${after.last.slowDrawables} slow drawables; last: ${after.last.lastStarvation}`)
}

// A draw whose drawable never came: the window shows the previous color until
// the scene is presented again. Each tick changes the color once; 400 ms later
// the window's center pixel must show it.
const windowId = () => {
  const script = `import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list { if (w[kCGWindowName as String] as? String) == "Frame stall check" { print(w[kCGWindowNumber as String]!); break } }`
  return execFileSync('swift', ['-e', script], { encoding: 'utf8' }).trim()
}
const centerColor = (id: string, file: string) => {
  execFileSync('screencapture', ['-x', '-o', '-t', 'bmp', `-l${id}`, file])
  const bmp = readFileSync(file)
  const offset = bmp.readUInt32LE(10), width = bmp.readInt32LE(18), height = bmp.readInt32LE(22), bpp = bmp.readUInt16LE(28) / 8
  const stride = Math.ceil(width * bpp / 4) * 4
  const row = height > 0 ? height - 1 - Math.floor(height * 0.7) : Math.floor(-height * 0.7)
  const at = offset + row * stride + Math.floor(width / 2) * bpp
  const [b, g, r] = [bmp[at]!, bmp[at + 1]!, bmp[at + 2]!]
  return r > g ? 'red' : 'green'
}
for (const mode of ['log', 'on']) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-frame-capture-'))
  let wrong = 0, checked = 0
  const { last } = await run({ KYBERN_LAB_SLOW_MS: '1000', KYBERN_FRAME_STALL_TEST: 'drop-drawable:900', ...(mode === 'log' ? { KYBERN_FRAME_WATCHDOG: 'log' } : {}) }, 0, async lines => {
    await Bun.sleep(1500)
    const id = windowId()
    // Start from the next tick, so a capture never races the following one.
    let seen = lines().filter(line => line.includes(' tick ')).length
    for (let i = 0; i < 8; i++) {
      while (lines().filter(line => line.includes(' tick ')).length <= seen) await Bun.sleep(10)
      const ticks = lines().filter(line => line.includes(' tick '))
      seen = ticks.length
      const tick = Number(ticks.at(-1)!.split(' tick ')[1])
      await Bun.sleep(400)
      checked++
      if (centerColor(id, path.join(scratch, 'capture.bmp')) !== (tick % 2 ? 'green' : 'red')) wrong++
    }
  })
  rmSync(scratch, { recursive: true, force: true })
  if (mode === 'log') expect('drop-drawable, watchdog only reporting: stale frames stay on screen', wrong > 0 && last.droppedFrames > 0, `${wrong}/${checked} captures stale, ${last.droppedFrames} drawables dropped`)
  else expect('drop-drawable, watchdog on: the scene is presented again', wrong === 0 && last.droppedFrames > 0 && last.representedFrames > 0, `${wrong}/${checked} captures stale, ${last.droppedFrames} dropped, ${last.representedFrames} presented again`)
}
// After a starvation episode the window shows the current scene again: one color
// change a second, the emulated compositor stalled from 4 s to 7 s (then 11 s to
// 14 s), captures 400 ms after the ticks from 8 s on.
{
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-frame-capture-'))
  let wrong = 0, checked = 0
  const { last } = await run({ KYBERN_LAB_SLOW_MS: '1000', KYBERN_FRAME_STALL_TEST: 'starve-drawables:4000' }, 0, async lines => {
    await Bun.sleep(8000)
    const id = windowId()
    let seen = lines().filter(line => line.includes(' tick ')).length
    for (let i = 0; i < 3; i++) {
      while (lines().filter(line => line.includes(' tick ')).length <= seen) await Bun.sleep(10)
      const ticks = lines().filter(line => line.includes(' tick '))
      seen = ticks.length
      const tick = Number(ticks.at(-1)!.split(' tick ')[1])
      await Bun.sleep(400)
      checked++
      if (centerColor(id, path.join(scratch, 'capture.bmp')) !== (tick % 2 ? 'green' : 'red')) wrong++
    }
  })
  rmSync(scratch, { recursive: true, force: true })
  expect('starve-drawables, gate on: current frames on screen after the episode', wrong === 0 && last.drawableStarvations >= 1 && last.drawableRecoveries >= 1,
    `${wrong}/${checked} captures stale, ${last.drawableStarvations} episodes, ${last.drawableRecoveries} ended`)
}
assert.equal(failures.length, 0, failures.join('\n'))
console.log('ok  the frame watchdog repairs every stalled state')
