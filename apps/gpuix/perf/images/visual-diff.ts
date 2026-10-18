import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pngPixels } from '../../native/clip-pixels.ts'

const evidence = process.env.KYBERN_MEMORY_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/perf/images'
const rows = []
for (const theme of ['dark', 'light']) {
  for (const scene of ['image-shared', 'peer-after-eviction', 'home', 'image-reopened', 'editor', 'editor-reopened', 'code', 'home-after-code', 'editor-history-redo']) {
    const name = `${theme}-${scene}.png`
    const before = pngPixels(path.join(evidence, 'before-final-visual', name))
    const after = pngPixels(path.join(evidence, 'after-final-visual', name))
    assert.equal(before.width, after.width); assert.equal(before.height, after.height)
    let samples = 0, changed = 0, changedOver2 = 0, maximum = 0, sum = 0
    // Compare every functional canvas pixel; exclude only OS chrome/corners.
    for (let y = 80; y < before.height - 32; y++) {
      for (let x = 32; x < before.width - 32; x++) {
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
assert(rows.every(row => row.changed === 0), 'Inspect a changed functional canvas')
