import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pngPixels } from '../../native/clip-pixels.ts'

const evidence = process.env.KYBERN_MEMORY_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/perf/memory'
const rows = []
for (const theme of ['dark', 'light']) {
  for (const scene of ['image-shared', 'peer-after-eviction', 'home', 'image-reopened', 'editor', 'editor-reopened', 'code', 'home-after-code']) {
    const name = `${theme}-${scene}.png`
    const before = pngPixels(path.join(evidence, 'before-final-visual', name))
    const after = pngPixels(path.join(evidence, 'after-final-visual', name))
    assert.equal(before.width, after.width); assert.equal(before.height, after.height)
    let samples = 0, changed = 0, changedOver2 = 0, maximum = 0, sum = 0
    // Sample the functional canvas every four pixels, excluding native window
    // chrome/corners. This is not a whole-image equality assertion.
    for (let y = 80; y < before.height - 32; y += 4) {
      for (let x = 32; x < before.width - 32; x += 4) {
        const a = before.at(x, y), b = after.at(x, y)
        const delta = Math.max(...a.map((value, channel) => Math.abs(value - b[channel]!)))
        samples++; if (delta) changed++; if (delta > 2) changedOver2++
        maximum = Math.max(maximum, delta); sum += delta
      }
    }
    rows.push({ name, samples, changed, changedOver2, maximum, meanMaximumChannelDelta: sum / samples })
  }
}
writeFileSync(path.join(evidence, 'visual-diff.json'), JSON.stringify(rows, null, 2))
console.log(JSON.stringify(rows, null, 2))
assert(rows.every(row => row.changedOver2 / row.samples < 0.001), 'Inspect a changed functional canvas')
