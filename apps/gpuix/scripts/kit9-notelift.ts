/**
 * R4-2 GPUIX side: the note card lift as frame strips (clock paused, frames set at fixed offsets) plus a live
 * run that records presented-frame intervals while the lift plays (no screenshots in the timing interval).
 *
 *   bun scripts/kit9-notelift.ts [--light] [--reduced] [--ms 180]
 * Needs the seeded scratch daemon (`bun scripts/visual-pair.ts notes-hover --keep`).
 */
import { mkdirSync } from 'node:fs'
import { EVIDENCE, start, waitUntil } from './kit9-lib.ts'
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const ms = process.argv.includes('--ms') ? process.argv[process.argv.indexOf('--ms') + 1]! : '140'
const theme = light ? 'light' : 'dark'
const dir = `${EVIDENCE}/notelift`
mkdirSync(dir, { recursive: true })
const app = await start({ light, reduced, seeded: true, full: true, env: { KYBERN_NOTE_LIFT_MS: ms } })
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
try {
  await app.getByTestId('rail-notes').click()
  await waitUntil(async () => (await app.getByTestId('notes-filter-all').count()) > 0, 20_000, 'notes page')
  await app.getByTestId('notes-filter-all').click()
  await sleep(1200)
  // The "Project brief" card.
  const tree = (await app.call('getTree', {})).tree as any
  const text = (n: any): string => (n.text ?? '') + (n.children ?? []).map(text).join('')
  const find = (n: any): any => (n?.testId?.startsWith('note-card-') && text(n).includes('Project brief') ? n : n?.children?.map(find).find(Boolean))
  const id = find(tree).testId.slice('note-card-'.length)
  const park = () => app.mouse.move({ x: 1275, y: 815 })
  await park(); await sleep(500)
  const thumb = () => app.getByTestId(`note-thumb-${id}`)
  const rest = await thumb().bounds()
  console.log('rest', JSON.stringify(rest))

  // Live timing first: move the pointer on, collect presented frames for 500 ms. No screenshots in the interval.
  const timingRuns: { frames: number; p50: number; p95: number }[] = []
  for (let run = 0; run < 3; run++) {
    await park(); await sleep(600)
    const mark = app.frameTimes().at(-1) ?? 0
    await app.getByTestId(`note-card-${id}`).hover()
    await sleep(500)
    const frames = app.frameTimes().filter((t) => t > mark)
    const dt = frames.slice(1).map((t, i) => t - frames[i]!).sort((a, b) => a - b)
    timingRuns.push({ frames: frames.length, p50: dt[Math.floor(dt.length * 0.5)] ?? NaN, p95: dt[Math.floor(dt.length * 0.95)] ?? NaN })
  }
  console.log(`frames while the lift plays (${theme}${reduced ? ', reduced' : ''}, KYBERN_FULL_RATE=1, ${ms} ms):`, JSON.stringify(timingRuns))

  // Strip: pause, hover, step through the tween.
  await park(); await sleep(600)
  const at = await app.clock.pause()
  await app.getByTestId(`note-card-${id}`).hover()
  await sleep(150)
  const offsets = [0, 17, 33, 50, 67, 83, 100, 117, 133, 150, 183, 220]
  const tops: Record<number, number> = {}
  for (const o of offsets) {
    await app.clock.set(at + o)
    const b = await thumb().bounds()
    tops[o] = Math.round((b.y - rest.y) * 1000) / 1000
    await app.screenshot({ path: `${dir}/gpuix-${theme}${reduced ? '-reduced' : ''}-${ms}ms-${String(o).padStart(3, '0')}.png` })
  }
  console.log('translateY by offset:', JSON.stringify(tops))
  await app.clock.resume()
  await Bun.write(`${dir}/gpuix-${theme}${reduced ? '-reduced' : ''}-${ms}ms.json`, JSON.stringify({ rest, tops, timingRuns }, null, 2))
} finally { await app.closeAll() }
