/**
 * Sidebar hover marquee (audit 3.29 / 25.12), GPUIX side: strips of the long-title row while the pointer rests on it
 * (clock paused after the 190 ms measure, then stepped) and while it pans back, plus live frame intervals during the pan.
 * Needs the seeded scratch daemon with `bun scripts/kit9-titles.ts --long`. Desktop reference: kit9-marquee-tauri.mjs.
 *
 *   bun scripts/kit9-marquee.ts [--light] [--reduced]
 * Desktop offset d (ms after the pointer arrived) is GPUIX clock offset d - 190 once the measure timer has fired.
 */
import { mkdirSync } from 'node:fs'
import { connect, readState } from '../visual/fixture.ts'
import { EVIDENCE, start, waitUntil } from './kit9-lib.ts'
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const theme = light ? 'light' : 'dark'
const dir = `${EVIDENCE}/marquee`
mkdirSync(dir, { recursive: true })
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
const app = await start({ light, reduced, seeded: true, full: true })
try {
  await waitUntil(async () => (await app.getByTestId('sidebar-resize').count()) > 0, 20_000, 'sidebar')
  await sleep(600)
  const client = await connect(readState()!)
  const long = (await client.call('threads.list', {})).threads.find((t: any) => t.title.startsWith('A very long'))!
  if (!(await app.getByTestId(`thread-${long.id}`).count())) { await app.getByTestId('app-ready').press('cmd-b'); await sleep(1200) }
  const b = await app.getByTestId(`thread-${long.id}`).bounds()
  console.log('row', JSON.stringify(b))
  const crop = async (name: string) => {
    const full = `${dir}/${name}-full.png`
    await app.screenshot({ path: full })
    Bun.spawnSync(['swift', `${import.meta.dir}/kit9-crop.swift`, full, `${dir}/${name}.png`, String(b.x * 2 - 8), String(b.y * 2 - 4), String(b.width * 2 + 16), String(b.height * 2 + 8)])
    Bun.spawnSync(['rm', '-f', full])
  }
  const park = () => app.mouse.move({ x: 700, y: 600 })
  await park(); await sleep(500)
  // Live: frame intervals while hovering through the pan (no screenshots in the interval).
  const mark = app.frameTimes().at(-1) ?? 0
  await app.mouse.move({ x: b.x + 60, y: b.y + b.height / 2 })
  await sleep(2600)
  const frames = app.frameTimes().filter((t) => t > mark)
  const dt = frames.slice(1).map((t, i) => t - frames[i]!).sort((a, c) => a - c)
  console.log(`frames during the pan (${theme}${reduced ? ', reduced' : ''}, KYBERN_FULL_RATE=1): n=${frames.length} p50=${dt[Math.floor(dt.length * 0.5)]} p95=${dt[Math.floor(dt.length * 0.95)]}`)

  // Strip: pause, hover, wait for the measure, step.
  await park(); await sleep(1200)
  const at = await app.clock.pause()
  await app.mouse.move({ x: b.x + 60, y: b.y + b.height / 2 })
  await sleep(450)
  const offsets = [0, 160, 1160, 2160, 3160, 8000] // desktop d = o + 190
  for (const o of offsets) { await app.clock.set(at + o); await crop(`gpuix-${theme}${reduced ? '-reduced' : ''}-pan-${String(o + 190).padStart(4, '0')}`) }
  // Back: leave, step the pan home.
  await app.clock.set(at + 8000)
  await app.mouse.move({ x: 700, y: 600 })
  await sleep(150)
  for (const o of [0, 100, 200, 300, 400, 500]) { await app.clock.set(at + 8000 + o); await crop(`gpuix-${theme}${reduced ? '-reduced' : ''}-back-${String(o).padStart(3, '0')}`) }
  await app.clock.resume()
} catch (e) { console.error(e); process.exitCode = 1 } finally { await app.closeAll(); process.exit(process.exitCode ?? 0) }
