/**
 * Attention pop (`t-pop`), GPUIX side: the sidebar "Projects · Pinned" filter summary mounts and pops (scale 0.85 -> 1,
 * opacity 0.4 -> 1, 250 ms --ease-bounce). The native animation reads the real clock, so each offset is its own run with
 * KYBERN_PAINT_PHASE_MS frozen at that offset (the spinner check does the same). Also: frame intervals during a live pop
 * and the idle check (no frames after it ends). Desktop: kit9-pop-tauri.mjs.
 *   bun scripts/kit9-pop.ts [--light] [--reduced] [--offsets 0,50,100,150,200,250,350]
 */
import { mkdirSync } from 'node:fs'
import { EVIDENCE, resetSeededUi, start, waitUntil } from './kit9-lib.ts'
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const theme = light ? 'light' : 'dark'
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined)
const offsets = (arg('--offsets') ?? '0,50,100,150,200,250,350').split(',').map(Number)
const dir = `${EVIDENCE}/pop`
mkdirSync(dir, { recursive: true })
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
async function run(phase: number | null) {
  resetSeededUi()
  const app = await start({ light, reduced, seeded: true, full: true, visible: phase == null, env: phase == null ? {} : { KYBERN_PAINT_PHASE_MS: String(phase) } })
  try {
    await waitUntil(async () => (await app.getByTestId('sidebar-resize').count()) > 0, 20_000, 'sidebar')
    await sleep(600)
    // Reveal the header toolbar and open the filter menu.
    await app.mouse.move({ x: 150, y: 220 }); await sleep(400)
    if (!(await app.getByTestId('sidebar-filter').count())) { await app.getByTestId('app-ready').press('cmd-b'); await sleep(1000); await app.mouse.move({ x: 150, y: 224 }); await sleep(400) }
    await app.getByTestId('sidebar-filter').click(); await sleep(300)
    // The "Pinned" row of the filter menu (the sidebar's menu items carry no test id).
    await app.mouse.move({ x: 113, y: 307 }); await sleep(250)
    const mark = app.frameTimes().at(-1) ?? 0
    await app.mouse.down({ x: 113, y: 307 }); await app.mouse.up({ x: 113, y: 307 })
    const seen = new Set<number>()
    const note = () => { for (const t of app.frameTimes()) if (t > mark) seen.add(t) }
    const end = Date.now() + (phase == null ? 700 : 900)
    while (Date.now() < end) { note(); await sleep(40) }
    return { app, mark, seen }
  } catch (e) { await app.closeAll(); throw e }
}
// Frozen strips.
const names: string[] = []
for (const phase of offsets) {
  const { app } = await run(phase)
  try {
    const full = `${dir}/full-${phase}.png`
    await app.screenshot({ path: full })
    // The header row: "Projects · Pinned", sidebar top; points -> pixels x2.
    const out = `${dir}/gpuix-${theme}${reduced ? '-reduced' : ''}-${String(phase).padStart(3, '0')}.png`
    Bun.spawnSync(['swift', `${import.meta.dir}/kit9-crop.swift`, full, out, '110', '405', '560', '75'])
    Bun.spawnSync(['rm', '-f', full]); names.push(out)
  } finally { await app.closeAll() }
}
// Live: frame cadence during the pop, then idle. The menu click can miss while the menu is still opening: retry until it popped.
for (let attempt = 0; attempt < 4; attempt++) {
  const { app, mark, seen } = await run(null)
  try {
    const t0 = [...seen].filter((t) => t > mark).sort((a, b) => a - b)[0] ?? mark
    const frames = app.frameTimes().filter((t) => t >= t0 && t < t0 + 330)
    if (frames.length < 8 && !reduced) { console.log(`attempt ${attempt}: only ${frames.length} frames, the click missed`); continue }
    console.log('frame times (ms, relative):', frames.map((t) => Math.round(t - frames[0]!)).join(' '))
    const dt = frames.slice(1).map((t, i) => t - frames[i]!).sort((a, b) => a - b)
    console.log(`live pop (${theme}${reduced ? ', reduced' : ''}, KYBERN_FULL_RATE=1): frames=${frames.length} p50=${dt[Math.floor(dt.length * 0.5)]} p95=${dt[Math.floor(dt.length * 0.95)]} max=${dt.at(-1)}`)
    await sleep(1200)
    const before = app.frameTimes().length
    await sleep(1500)
    console.log('frames presented in 1.5 s of idle after the pop:', app.frameTimes().length - before)
    break
  } finally { await app.closeAll() }
}
console.log(names.join('\n'))
process.exit(0)
