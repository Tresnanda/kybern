/**
 * R4-1: fast pointer sweeps down the rail, then count the tooltips still painted once the pointer is away.
 *
 * Input is GPUIX's native mouse simulation (`app.mouse.move`, the same GPUI dispatch path as OS events), pipelined so
 * several moves land within one frame. Real OS events (`cliclick`) are unavailable here: this terminal lacks the
 * post-event permission and the user's browser covers the background window.
 *
 *   bun scripts/kit9-tooltips.ts [--light] [--reduced] [--label before|after]
 */
import { EVIDENCE, start, waitUntil } from './kit9-lib.ts'
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'run'
const app = await start({ light, reduced })
try {
  await Bun.sleep(1200)
  const ids = ['rail-home', 'rail-notes', 'rail-tasks', 'rail-pulls', 'rail-usage', 'rail-settings']
  const spots: { id: string; x: number; y: number }[] = []
  for (const id of ids) {
    const c = await app.getByTestId(id).center().catch(() => null)
    if (c) spots.push({ id, x: Math.round(c.x), y: Math.round(c.y) })
  }
  console.log('spots', JSON.stringify(spots))
  const away = { x: 900, y: 400 }
  const move = (p: { x: number; y: number }) => app.mouse.move(p)
  const tips = () => app.getByTestId('tooltip').count()
  const results: Record<string, number> = {}
  /** Pipelined: all moves are sent without awaiting each, `gap` ms apart (0 = back to back). */
  const burst = async (points: { x: number; y: number }[], gap: number) => {
    const sends: Promise<unknown>[] = []
    for (const p of points) {
      sends.push(move(p))
      if (gap) await Bun.sleep(gap)
    }
    await Promise.all(sends)
  }
  const trial = async (name: string, run: () => Promise<void>, settleMs = 1000) => {
    await move(away)
    await waitUntil(async () => (await tips()) === 0, 4000, 'no tooltips before trial').catch(() => {})
    await run()
    let peak = 0
    const end = Date.now() + settleMs
    while (Date.now() < end) { peak = Math.max(peak, await tips()); await Bun.sleep(10) }
    if (peak > 1) throw new Error(`${name}: ${peak} tooltips visible at once`)
    const after = await tips()
    results[name] = after
    console.log(`${name}: peak ${peak}, visible ${settleMs} ms after the pointer left: ${after}`)
    if (after > 0 && !Object.keys(results).some((k) => k !== name && results[k]! > 0)) await app.screenshot({ path: `${EVIDENCE}/${label}-stuck-${name}-${light ? 'light' : 'dark'}${reduced ? '-reduced' : ''}.png` })
  }
  // Positive controls: the tooltip does show, only one at a time, and hides as soon as the pointer leaves.
  await move(away)
  await move(spots[1]!)
  await waitUntil(async () => (await tips()) === 1, 3000, 'tooltip after dwelling on Notes')
  console.log('PASS control: dwelling on Notes shows one tooltip')
  await move(spots[2]!)
  await Bun.sleep(150)
  const handOver = await tips()
  if (handOver !== 1) throw new Error(`expected one tooltip after moving Notes → Tasks, saw ${handOver}`)
  console.log('PASS control: moving to the next button leaves exactly one tooltip (instant hand-over)')
  await move(away)
  await waitUntil(async () => (await tips()) === 0, 400, 'tooltip hides promptly once the pointer leaves')
  console.log('PASS control: leaving hides it within 400 ms (incl. automation polling)')
  const sweepDown = [...spots, away], sweepUpDown = [...spots, ...spots.slice().reverse(), away]
  for (let i = 0; i < 6; i++) await trial(`sweep-nowait-${i}`, () => burst(sweepDown, 0))
  for (let i = 0; i < 6; i++) await trial(`sweep-4ms-${i}`, () => burst(sweepDown, 4))
  for (let i = 0; i < 6; i++) await trial(`sweep-16ms-${i}`, () => burst(sweepDown, 16))
  for (let i = 0; i < 6; i++) await trial(`sweep-40ms-${i}`, () => burst(sweepDown, 40))
  for (let i = 0; i < 6; i++) await trial(`sweep-120ms-${i}`, () => burst(sweepDown, 120))
  for (let i = 0; i < 4; i++) await trial(`dwell-then-race-${i}`, async () => { await move(spots[1]!); await Bun.sleep(900); await burst(sweepDown.slice(2), 0) })
  for (let i = 0; i < 4; i++) await trial(`down-up-${i}`, () => burst(sweepUpDown, 4))
  // The title bar's tooltips use the same component: sweep its toggle and history buttons too.
  const bar: { x: number; y: number }[] = []
  for (const id of ['sidebar-toggle', 'nav-back', 'nav-forward', 'titlebar-new-thread', 'dock-toggle']) {
    const c = await app.getByTestId(id).center().catch(() => null)
    if (c) bar.push({ x: Math.round(c.x), y: Math.round(c.y) })
  }
  console.log('title bar spots', bar.length)
  if (bar.length > 1) {
    for (let i = 0; i < 6; i++) await trial(`titlebar-nowait-${i}`, () => burst([...bar, away], 0))
    for (let i = 0; i < 6; i++) await trial(`titlebar-4ms-${i}`, () => burst([...bar, ...bar.slice().reverse(), away], 4))
  }
  const stuck = Object.entries(results).filter(([, v]) => v > 0)
  console.log(stuck.length ? `STUCK in ${stuck.length}/${Object.keys(results).length} trials: ${stuck.map(([k, v]) => `${k}=${v}`).join(', ')}` : `PASS: 0 stuck in ${Object.keys(results).length} trials`)
  process.exitCode = stuck.length ? 1 : 0
} finally { await app.close() }
