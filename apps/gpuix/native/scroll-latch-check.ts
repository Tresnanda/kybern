// Wheel latching (GPUI `scroll_latch.rs`) in a real window, on scroll-latch-lab.tsx: a transcript scrolled to the middle
// under the floating composer with an overflowing tray, a short draft and the slash list's popup.
//   - a gesture inside the tray scrolls only the tray;
//   - a flick past the tray's end leaves the transcript where it was;
//   - a new gesture that starts at the tray's end scrolls the transcript;
//   - a gesture over the composer field scrolls the transcript;
//   - the slash list scrolls alone, and a flick past its end leaves the transcript (menus keep the wheel to themselves).
// `SCROLL_LATCH_CONTROL=1` runs the same gestures with `KYBERN_SCROLL_LATCH=0` and prints what moved, without asserting
// (the double scroll this fixes). Output: one line per step with the distances each scroller moved.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'

const control = process.env.SCROLL_LATCH_CONTROL === '1'
const scratchRoot = process.env.TMPDIR ?? path.join(process.env.HOME!, '.cache', 'tmp')
const scratch = mkdtempSync(path.join(scratchRoot, 'scroll-latch-'))
const f = await launchFixture(path.join(import.meta.dir, 'scroll-latch-lab.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_REDUCED_MOTION: '1', KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark',
  KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '',
  ...(control ? { KYBERN_SCROLL_LATCH: '0' } : {}),
})
const a = f.app
let gestures = 0
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 30000 })
  await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })

  const mounted = async (id: string) => (await a.getByTestId(id).count()) > 0
  /** How far a list has scrolled: a mounted row's index × its height, less how far it sits below the list's top. */
  const offsetOf = async (list: string, row: (i: number) => string, count: number, height: number, hint: { at: number }) => {
    const top = (await a.getByTestId(list).bounds()).y
    for (let d = 0; d < count; d++) {
      for (const i of d === 0 ? [hint.at] : [hint.at + d, hint.at - d]) {
        if (i < 0 || i >= count || !(await mounted(row(i)))) continue
        // Mounted rows outside the viewport have no painted bounds.
        const b = await a.getByTestId(row(i)).bounds().catch(() => null)
        if (!b || b.y + b.height < top) continue
        hint.at = i
        return i * height - (b.y - top)
      }
    }
    throw new Error(`${list}: no mounted row`)
  }
  const transcriptHint = { at: 0 }, trayHint = { at: 0 }, listHint = { at: 0 }
  const transcript = () => offsetOf('transcript', i => `row-${i}`, 240, 40, transcriptHint)
  const tray = () => offsetOf('tray-frame', i => `runtime-task-t${i}`, 16, 28, trayHint)
  const completion = () => offsetOf('completion-list', i => `command-${i}`, 30, 32, listHint)
  const gesture = async (key: string) => {
    await a.getByTestId('app-ready').press(key)
    gestures++
    const deadline = Date.now() + 10000
    while ((await a.getByTestId('state').textContent()) !== `gestures:${gestures}`) {
      if (Date.now() > deadline) throw new Error(`gesture ${key} never finished`)
      await Bun.sleep(20)
    }
    await Bun.sleep(250)
  }
  const step = async (label: string, key: string, inner: () => Promise<number>) => {
    const [t0, i0] = [await transcript(), await inner()]
    await gesture(key)
    const [t1, i1] = [await transcript(), await inner()]
    const moved = { transcript: Math.round(t1 - t0), inner: Math.round(i1 - i0) }
    console.log(`${label}: transcript ${moved.transcript}px, inner list ${moved.inner}px`)
    return moved
  }
  const check = (ok: boolean, message: string) => { if (!control) assert.ok(ok, message) }

  // The transcript to the middle, from above the composer.
  await gesture('1')
  const middle = await transcript()
  assert.ok(middle > 1500, `the transcript scrolls to its middle (${middle})`)
  // Background tasks alone start the tray closed: open it.
  if (!(await mounted('composer-tray-list'))) { await a.getByTestId('composer-tray-toggle').click(); await Bun.sleep(500) }
  assert.ok(await mounted('composer-tray-list'), 'the tray overflows into its scrolling list')
  if (process.env.SCROLL_LATCH_SHOT) await a.screenshot({ path: process.env.SCROLL_LATCH_SHOT })

  let m = await step('tray, one gesture', 'y', tray)
  check(m.inner > 100 && m.transcript === 0, 'a gesture inside the tray scrolls only the tray')
  m = await step('tray, flick past its end', '2', tray)
  check(m.inner > 0 && m.transcript === 0, 'a flick past the tray\'s end leaves the transcript')
  await Bun.sleep(600)
  m = await step('tray, new gesture at its end', 'y', tray)
  check(m.inner === 0 && m.transcript > 100, 'a new gesture at the tray\'s end scrolls the transcript')
  m = await step('composer field', 'f', tray)
  check(m.inner === 0 && m.transcript > 100, 'a gesture over the composer field scrolls the transcript')

  // A mouse wheel has no phases: a pause longer than half a second starts a new gesture, and the tray (now at its end) can
  // still move up.
  await Bun.sleep(600)
  {
    const [t0, i0] = [await transcript(), await tray()]
    const frame = await a.getByTestId('tray-frame').bounds()
    for (let i = 0; i < 3; i++) { await a.mouse.wheel({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }, 0, 40); await Bun.sleep(30) }
    await Bun.sleep(300)
    const moved = { transcript: Math.round(await transcript() - t0), inner: Math.round(await tray() - i0) }
    console.log(`tray, mouse wheel up (no phases): transcript ${moved.transcript}px, inner list ${moved.inner}px`)
    check(moved.inner < -100 && moved.transcript === 0, 'a phase-less wheel inside the tray scrolls only the tray')
  }

  // A draft long enough to scroll inside the field (it opens at its end, at the caret): the field keeps its gestures, and
  // one that starts at its end reaches the transcript.
  await a.getByTestId('app-ready').press('d'); await Bun.sleep(300)
  const none = async () => 0
  for (const pass of [1, 2]) {
    m = await step(`long draft, gesture up ${pass}`, 'g', none)
    check(m.transcript === 0, 'a gesture up inside a long draft scrolls only the field')
  }
  m = await step('long draft, one gesture down', 'f', none)
  check(m.transcript === 0, 'a gesture down inside a long draft scrolls only the field')
  m = await step('long draft, flick past its end', '3', none)
  check(m.transcript === 0, 'a flick past the field\'s end leaves the transcript')
  m = await step('long draft, new gesture at its end', 'f', none)
  check(m.transcript > 100, 'a new gesture at the field\'s end scrolls the transcript')
  await a.getByTestId('app-ready').press('d'); await Bun.sleep(300)

  await a.getByTestId('app-ready').press('o')
  await a.getByTestId('completion-list').waitFor({ timeoutMs: 5000 })
  await Bun.sleep(300)
  m = await step('slash list, one gesture', 'c', completion)
  check(m.inner > 100 && m.transcript === 0, 'a gesture inside the slash list scrolls only the list')
  m = await step('slash list, flick past its end', '4', completion)
  check(m.inner > 0 && m.transcript === 0, 'a flick past the slash list\'s end leaves the transcript')
  m = await step('slash list, new gesture at its end', 'c', completion)
  check(m.inner === 0 && m.transcript === 0, 'the slash list is a menu: the wheel over it never reaches the transcript')
  console.log(control ? 'control run (KYBERN_SCROLL_LATCH=0): no assertions' : 'ok: inner lists keep their gestures; new gestures at their ends and over the field reach the transcript')
} catch (error) {
  console.error(f.diagnostics())
  throw error
} finally {
  await f.close()
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
