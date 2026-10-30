// A cached island replayed inside another `paintTransform` scope keeps the scopes nested in it (the fork's
// `prepare_transform_replay`): across renders beside the island, no presented frame shows the square held at opacity 0
// or the translated square at its untransformed place. Reads what the window presented (`KYBERN_PRESENT_DUMP`), not a
// fresh render. `KYBERN_NESTED_SCOPE_REPLAY=0 bun native/nested-replay-check.ts --control` expects the old flash instead.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { pixels } from './png.ts'

const control = process.argv.includes('--control')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build/nested-replay')
for (const theme of ['dark', 'light']) {
  const frames = path.join(out, `${theme}${control ? '-control' : ''}`)
  rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true })
  const f = await launchFixture(path.join(import.meta.dir, 'nested-replay-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_PRESENT_DUMP: frames })
  let red = 0, stray = 0, moved = 0, total = 0
  try {
    const a = f.app
    await a.getByTestId('app-ready').waitFor()
    await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
    await Bun.sleep(600)
    for (let i = 1; i <= 12; i++) {
      await a.call('keyDown', { key: 't' }); await a.getByText(`Tick ${i}`).waitFor()
      // Tree commits can run ahead of drawable availability. Wait for the
      // exact submitted state without forcing a new render with a screenshot.
      const deadline = Date.now() + 3000
      let shown = false
      while (!shown && Date.now() < deadline) {
        for (const name of readdirSync(frames).filter(name => name.endsWith('.png')).sort().reverse().slice(0, 3)) {
          try {
            const p = pixels(path.join(frames, name)), scale = p.w / 520
            const tick = Array.from({ length: 4 }, (_, bit) => p.at((402 + bit * 8) * scale, 51 * scale))
              .reduce((value, color, bit) => value | (color[1]! > color[0]! ? 1 << bit : 0), 0)
            if (tick === i) { shown = true; break }
          } catch { /* A presented-frame dump is still being written. */ }
        }
        if (!shown) await Bun.sleep(20)
      }
      assert.ok(shown, `Tick ${i} never reached the submitted frame`)
    }
    await Bun.sleep(600)
  } finally { await f.close() }
  await Bun.sleep(300)
  const island = { x: 40, y: 40 + 18 }
  for (const file of readdirSync(frames).filter(name => name.endsWith('.png')).sort()) {
    const p = pixels(path.join(frames, file)), scale = p.w / 520
    const at = (x: number, y: number) => p.at(x * scale, y * scale)
    // The island's fill must be there (its first frames may precede the island); then check the squares.
    const [fr, fg, fb] = at(island.x + 150, island.y + 10)
    if (!(fb! > 150 && fr! < 120)) continue
    total++
    const [hr, hg, hb] = at(island.x + 50, island.y + 50)
    if (hr! > 180 && hg! < 80 && hb! < 80) red++
    const [sr, sg, sb] = at(island.x + 50, island.y + 120)
    if (sg! > 180 && sr! < 80 && sb! < 80) stray++
    const [mr, mg, mb] = at(island.x + 170, island.y + 120)
    if (mg! > 180 && mr! < 80 && mb! < 80) moved++
  }
  console.log(`${theme}${control ? ' (control)' : ''}: ${total} presented frames with the island; hidden square shown in ${red}, translated square at its untransformed place in ${stray}, at its place in ${moved}`)
  assert.ok(total >= 12, `only ${total} presented frames showed the island`)
  if (control) assert.ok(red + stray > 0, 'the control (KYBERN_NESTED_SCOPE_REPLAY=0) did not reproduce the flash')
  else {
    assert.equal(red, 0, 'a presented frame showed the square held at opacity 0')
    assert.equal(stray, 0, 'a presented frame showed the translated square at its untransformed place')
    assert.equal(moved, total, 'a presented frame lost the translated square')
  }
}
console.log(control ? 'ok: the control reproduces the flash' : 'ok: nested scopes survive cached replays')
