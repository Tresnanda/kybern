/**
 * R4-1 stuck rail tooltips with real AppKit mouse events (`kit9-nsevent-app.ts`), not GPUIX's mouse simulation:
 * fast sweeps down the rail (0–40 ms between moves, all inside one frame at 0), dwell-then-sweep and down-up, then
 * count the tooltips still painted 1 s after the pointer left. The first stuck state is captured by window id.
 *
 *   bun scripts/kit9-tooltips-nsevent.ts [--root <other checkout>/apps/gpuix] [--label base] [--data <scratch daemon dir>] [--light] [--reduced]
 *
 * On bf0ee5bd (with a `testId="tooltip"` added to its `Tip`) 11 of 54 trials left up to 6 tooltips; kit9: 0 of 54.
 */
import path from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { launchFixture } from '../native/frame-harness.ts'
import { CLIENT_DIR, DATA_DIR, EVIDENCE, guardEnv, waitUntil, windowFrame } from './kit9-lib.ts'
const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d)
const root = arg('--root', path.resolve(import.meta.dir, '..')), label = arg('--label', 'kit9')
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const tag = `${label}-${light ? 'light' : 'dark'}${reduced ? '-reduced' : ''}`
const out = `${EVIDENCE}/tooltips-nsevent`
mkdirSync(out, { recursive: true })
const PLAN = `${out}/.plan-${tag}.json`
const f = await launchFixture(path.join(import.meta.dir, 'kit9-nsevent-app.ts'), guardEnv({
  REVIEW_MAIN: `${root}/src/main.tsx`, REVIEW_PLAN: PLAN, KYBERN_DATA_DIR: arg('--data', DATA_DIR), KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR,
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: light ? 'light' : 'dark', KYBERN_OPAQUE: '1', KYBERN_WINDOW_SIZE: '1280x820',
  ...(reduced ? { KYBERN_REDUCED_MOTION: '1' } : {}),
}))
const app = f.app
const tips = () => app.getByTestId('tooltip').count()
const play = async (points: [number, number][], gapMs: number) => {
  rmSync(PLAN + '.done', { force: true })
  writeFileSync(PLAN, JSON.stringify({ points, gapMs }))
  process.kill(f.pid, 'SIGUSR1')
  await waitUntil(() => existsSync(PLAN + '.done'), 10_000, 'plan played')
}
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await Bun.sleep(1000) // the first injected dwell right after app-ready is sometimes missed, on the base too
  const spots: [number, number][] = []
  for (const id of ['rail-home', 'rail-notes', 'rail-tasks', 'rail-pulls', 'rail-usage', 'rail-settings']) {
    const p = await app.getByTestId(id).center().catch(() => null)
    if (p) spots.push([Math.round(p.x), Math.round(p.y)])
  }
  const away: [number, number] = [900, 400]
  await play([away, spots[1]!], 0)
  await waitUntil(async () => (await tips()) === 1, 3000, 'tooltip after dwelling on Notes')
  await play([away], 0)
  await waitUntil(async () => (await tips()) === 0, 1000, 'tooltip hides after leaving')
  console.log('control: a dwell shows one tooltip, leaving hides it')
  const results: Record<string, number> = {}
  const trial = async (name: string, run: () => Promise<void>) => {
    await play([away], 0)
    await waitUntil(async () => (await tips()) === 0, 4000, 'clear before trial').catch(() => {})
    await run()
    let peak = 0
    const end = Date.now() + 1000
    while (Date.now() < end) { peak = Math.max(peak, await tips()); await Bun.sleep(10) }
    const after = (results[name] = await tips())
    if (after > 0) {
      console.log(`STUCK ${name}: ${after} visible 1 s after the pointer left (peak ${peak})`)
      const w = windowFrame(f.pid)
      if (w && Object.values(results).filter((v) => v > 0).length === 1) Bun.spawnSync(['screencapture', '-x', '-o', '-l', String(w.id), `${out}/${tag}-stuck-${name}.png`])
    }
  }
  const down = [...spots, away], downUp = [...spots, ...spots.slice().reverse(), away]
  for (const gap of [0, 4, 8, 16, 40]) for (let i = 0; i < 6; i++) await trial(`sweep-${gap}ms-${i}`, () => play(down, gap))
  for (const gap of [0, 8, 16]) for (let i = 0; i < 6; i++) await trial(`dwell-then-sweep-${gap}ms-${i}`, async () => {
    await play([spots[1]!], 0)
    await waitUntil(async () => (await tips()) === 1, 3000, 'dwell tooltip').catch(() => {})
    await play(down.slice(2), gap)
  })
  for (let i = 0; i < 6; i++) await trial(`down-up-8ms-${i}`, () => play(downUp, 8))
  const stuck = Object.entries(results).filter(([, v]) => v > 0)
  console.log(`${tag}: ${stuck.length ? `STUCK in ${stuck.length}/${Object.keys(results).length}` : `0 stuck in ${Object.keys(results).length}`} trials`)
  process.exitCode = stuck.length ? 1 : 0
} finally { rmSync(PLAN, { force: true }); rmSync(PLAN + '.done', { force: true }); await f.close() }
