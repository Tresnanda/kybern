// The sidebar title marquee pans its whole title through the row's clip, as WindowServer presents it (`screencapture -l`, real
// time: region painting and retained translation included, which the automation screenshot re-renders away). Before
// `translate_text_gpui.py` only the glyphs inside the clip at hover time were painted, so the pan slid them out and left the
// row empty. Asserts ink across the row box at the start, mid-pan and after the pan, and that the box's right half has ink at
// the end (the tail, not trailing space).
//   bun native/ui-lease.ts marquee bun scripts/marquee-check.ts
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../native/frame-harness.ts'
import { pixels } from '../native/png.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, '../native/build/marquee-check')
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
for (const theme of ['dark', 'light']) {
  const f = await launchFixture(path.join(import.meta.dir, 'marquee-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '0' })
  try {
    const a = f.app
    await a.getByTestId('ready').waitFor()
    const id = /window (\d+) onscreen=true/.exec(Bun.spawnSync(['swift', path.join(import.meta.dir, '../perf/bench/window-onscreen.swift'), String(f.pid)]).stdout.toString())?.[1]
    assert.ok(id, 'the lab window is not on screen')
    const row = await a.getByTestId('row').bounds()
    const ink = (file: string, from = 0) => {
      // The capture includes the window's title bar above the 120 pt content.
      const p = pixels(file), scale = p.w / 320, top = p.h / scale - 120, bg = p.at(p.w / 2, p.h - 12)
      let n = 0
      for (let y = row.y; y < row.y + row.height; y += 0.5) for (let x = row.x + from * row.width; x < row.x + row.width; x += 0.5) {
        const c = p.at(x * scale, (y + top) * scale)
        if (Math.abs(c[0]! - bg[0]!) + Math.abs(c[1]! - bg[1]!) + Math.abs(c[2]! - bg[2]!) > 120) n++
      }
      return n
    }
    const start = Date.now(), shots: Record<number, string> = {}
    // 350 ms delay, then 28 px/s over the overflow (about 300 px: ~11 s).
    for (const at of [600, 5000, 13500]) {
      await sleep(Math.max(0, start + at - Date.now()))
      shots[at] = path.join(out, `${theme}-${at}.png`)
      assert.equal(Bun.spawnSync(['screencapture', '-x', '-o', '-l', id, shots[at]!]).exitCode, 0, 'window capture failed')
    }
    for (const at of [600, 5000, 13500]) assert.ok(ink(shots[at]!) > 150, `${theme}: the title has ink at ${at} ms (${ink(shots[at]!)})`)
    assert.ok(ink(shots[13500]!, 0.5) > 60, `${theme}: the tail fills the right half after the pan (${ink(shots[13500]!, 0.5)})`)
    console.log(`ok ${theme}: marquee ink ${[600, 5000, 13500].map(at => ink(shots[at]!)).join(' / ')}, tail ${ink(shots[13500]!, 0.5)}`)
  } finally { await f.close() }
}
process.exit(0)
