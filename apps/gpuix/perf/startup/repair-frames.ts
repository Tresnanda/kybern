/** Older evidence stored native frame timestamps; retain raw values and derive
 * intervals before calculating percentile statistics. Idempotent. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const out = process.argv[2]!
for (const name of readdirSync(out).filter(name => name.endsWith('.json'))) {
  const file = path.join(out, name), rows = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(rows)) continue
  let changed = false
  for (const row of rows) {
    if (row.frameEncoding || !Array.isArray(row.frames)) continue
    const stamps: number[] = row.frames, intervals = new Map(stamps.slice(1).map((stamp, i) => [stamp, stamp - stamps[i]!]))
    row.frameTimestamps = stamps
    row.frames = stamps.slice(1).map(stamp => intervals.get(stamp))
    for (const key of ['resourceFrames', 'historyFrames']) if (Array.isArray(row[key])) row[key] = row[key].flatMap((stamp: number) => intervals.has(stamp) ? [intervals.get(stamp)] : [])
    row.frameEncoding = 'intervals-ms'
    changed = true
  }
  if (changed) writeFileSync(file, JSON.stringify(rows, null, 2))
}
