import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch, outputDir } from './check-harness.ts'
import { pixels } from './png.ts'

if (process.platform !== 'darwin') { console.log('skip: Metal drawable acquisition is macOS-only'); process.exit(0) }

const out = outputDir('update-freeze'), frames = path.join(out, 'frames'), state = path.join(out, 'state.json')
mkdirSync(frames, { recursive: true })
const f = await launch(path.join(import.meta.dir, 'update-freeze-lab.tsx'), { KYBERN_URL: '', KYBERN_FREEZE_STATE: state, KYBERN_PRESENT_DUMP: frames, KYBERN_APPEARANCE: 'dark' })
const checks: unknown[] = []
try {
  const a = f.app
  await a.getByTestId('app-ready').waitFor()
  await Bun.sleep(1000)
  const button = await a.getByTestId('click').center(), editor = await a.getByTestId('editor').center()
  const markers = await Promise.all([0, 1].map(bank => Promise.all(Array.from({ length: 8 }, (_, bit) => a.getByTestId(`state-${bank}-${bit}`).center()))))
  const displayedState = (p: ReturnType<typeof pixels>) => markers.map(bank => bank.reduce((value, b, bit) => {
    const color = p.at(b.x * p.w / 800, b.y * p.w / 800)
    return value | (color[1]! > color[0]! ? 1 << bit : 0)
  }, 0))
  const rows = await Promise.all([0, 1, 2].map(n => a.getByTestId(`row-${n}`).center()))
  const snapshot = () => JSON.parse(readFileSync(state, 'utf8'))
  for (let n = 1; n <= Number(process.env.KYBERN_FREEZE_TRIALS ?? 60); n++) {
    await a.mouse.move(rows[n % rows.length]!)
    await Bun.sleep(n % 4 === 0 ? 500 : 40)
    const started = performance.now()
    await a.mouse.click(button)
    await a.mouse.click(editor)
    await a.call('keystrokes', { keys: 'x' })
    await a.mouse.move(rows[(n + 1) % rows.length]!)
    const inputMs = performance.now() - started
    await Bun.sleep(120)
    const js = snapshot()
    const file = readdirSync(frames).filter(name => name.endsWith('.png')).sort().reverse().slice(0, 3).find(name => { try { pixels(path.join(frames, name)); return true } catch { return false } })
    assert.ok(file, 'A complete frame was submitted')
    const p = pixels(path.join(frames, file)), scale = p.w / 800
    const color = p.at((button.x + 50) * scale, button.y * scale)
    const shown = displayedState(p)
    if (!process.env.KYBERN_FRAME_STALL_TEST) for (let row = 0; row < rows.length; row++) {
      const point = rows[row]!, sample = p.at((point.x - 125) * scale, point.y * scale)
      assert.equal(sample[2]! > sample[0]! + 30, row === (n + 1) % rows.length, `Row ${row} hover follows the pointer while the marquee pans`)
    }
    checks.push({ n, clicks: js.clicks, chars: js.value.length, shown, color, inputMs, maxPumpLateMs: js.maxPumpLateMs, watchdog: js.watchdog })
    console.log(JSON.stringify(checks.at(-1)))
    if (inputMs > 500 || js.maxPumpLateMs > 250 || js.clicks !== n || js.value.length !== n || (!process.env.KYBERN_FRAME_STALL_TEST && shown.some(value => value !== n))) {
      copyFileSync(path.join(frames, file), path.join(out, 'failed.png'))
      assert.fail(`Input ${n} was not reflected: clicks=${js.clicks}, chars=${js.value.length}, inputMs=${inputMs}, pixel=${color}`)
    }
  }
  // A drawable may arrive for a viewport that changed while it was pending.
  for (let n = 0; n < 8; n++) { await a.getByTestId('app-ready').press('f8'); await Bun.sleep(60) }
  if (process.env.KYBERN_FRAME_STALL_TEST) {
    const js = snapshot()
    const deadline = Date.now() + 2500
    let displayed = false
    while (Date.now() < deadline) {
      for (const name of readdirSync(frames).filter(name => name.endsWith('.png')).sort().reverse().slice(0, 3)) {
        try {
          const p = pixels(path.join(frames, name)), shown = displayedState(p)
          displayed = shown[0] === js.clicks && shown[1] === js.value.length
          if (displayed) { copyFileSync(path.join(frames, name), path.join(out, 'recovered.png')); break }
        } catch {}
      }
      if (displayed) break
      await Bun.sleep(30)
    }
    assert.ok(displayed, 'The latest input appears without switching desktops or forcing a redraw')
    if (process.env.KYBERN_FRAME_STALL_TEST.startsWith('slow-drawable:')) assert.ok(snapshot().watchdog.slowDrawables >= 2, 'The delayed drawable acquisition ran repeatedly')
  }
} finally {
  writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2))
  writeFileSync(path.join(out, 'native.log'), f.diagnostics())
  await f.close()
  rmSync(frames, { recursive: true, force: true })
}
