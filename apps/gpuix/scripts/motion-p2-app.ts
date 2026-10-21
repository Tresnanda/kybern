// P2 motion strips on the real app (the items a lab cannot stand in for): the seeded visual-pair conversations on a scratch
// daemon, paused clock, one automation screenshot per offset. Needs VISUAL_SCRATCH under gpuix-scratch and a fixed daemon port:
//   VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p2 VISUAL_DAEMON_PORT=4367 \
//     bun native/ui-lease.ts gpuix-p2 bun scripts/motion-p2-app.ts [--theme dark|light] [--reduced 0|1] [--only a,b]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR, connect, readState, seed, startDaemon } from '../visual/fixture.ts'
import { loadAreaFixtures } from '../visual/load.ts'
import { open } from '../visual/screens/conversation.gpuix.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const theme = arg('--theme', 'dark'), reduced = arg('--reduced', '0'), only = arg('--only', '').split(',').filter(Boolean)
const dir = path.join(arg('--out', '/Users/mymac/projects/ade/previews/motion/gpuix-p2'), `app-${theme}-${reduced === '1' ? 'reduced' : 'normal'}`)
mkdirSync(dir, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// The conversation fixture's proxy (queue, held message, permissions) lives only as long as the process that seeded it: seed fresh every run.
let state = await startDaemon(true)
await seed(state); state = readState()!
const client = await connect(state)
const extra: Record<string, unknown> = {}
for (const [area, f] of Object.entries(await loadAreaFixtures())) if (f.ids) extra[area] = await f.ids(client)
client.close?.()
state = readState()!
const fx = { extra, notes: {}, tasks: {}, taskKeys: {} } as never
rmSync(path.join(DATA_DIR, 'gpuix-ui.json'), { force: true }); rmSync(CLIENT_DIR, { recursive: true, force: true })
const app: App = await launch({
  command: 'bun', args: [path.resolve(import.meta.dir, '../src/main.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_ENVIRONMENT_NAME: 'Development environment', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_REDUCED_MOTION: reduced },
})
type Crop = { x: number; y: number; w: number; h: number }
const sets: { name: string; frames: string[]; crop: Crop; cols: number }[] = []
const shot = async (name: string) => { await sleep(30); const file = path.join(dir, `${name}.png`); await app.screenshot({ path: file }); return file }
const byPrefix = async (prefix: string, nth = -1) => {
  const nodes = (await app.getByType('div').all()).filter(n => n.testId?.startsWith(prefix) && n.bounds && n.bounds.height > 0)
  const node = nodes.at(nth); if (!node?.bounds) throw new Error(`no ${prefix}* (${nodes.length})`); return node.bounds
}
const pad = (b: { x: number; y: number; width: number; height: number }, p: number, w = b.width + 2 * p, h = b.height + 2 * p): Crop => ({ x: Math.max(0, b.x - p), y: Math.max(0, b.y - p), w, h })
/** Trigger under a paused clock, wait for the real-time effects (RPC, state), then step the tween frame by frame. */
const run = async (id: string, crop: () => Promise<Crop>, trigger: () => Promise<void>, offsets: number[], cols = 4, settleMs = 250) => {
  if (only.length && !only.some(o => id.startsWith(o))) { await trigger(); await sleep(settleMs); return }
  const c = await crop()
  const at = await app.clock.pause()
  await trigger(); await sleep(settleMs)
  const frames: string[] = []
  let now = 0
  for (const o of offsets) { if (o > now) await app.clock.fastForward(o - now); now = o; frames.push(await shot(`${id}-${String(o).padStart(3, '0')}`)) }
  await app.clock.resume(); void at; await sleep(600)
  sets.push({ name: id, frames, crop: c, cols })
}
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await sleep(1800)
  // The transcript of a settled conversation: disclosure, hover footer, copy.
  await open(app, fx, arg('--thread', 'Date helper cleanup')); await sleep(800)
  if (await app.getByTestId('message-jump-0').count()) { await app.getByTestId('message-jump-0').click(); await sleep(1200) }
  if (process.argv.includes('--probe')) { console.log((await app.getByType('div').all()).filter(n => /^(worked-|user-|answer-|turn-row|transcript-bottom)/.test(n.testId ?? '')).map(n => `${n.testId} ${JSON.stringify(n.bounds)}`).join('\n')); process.exit(0) }
  await run('chevron-worked-open', async () => pad(await byPrefix('worked-', -1), 20, 760, 220), async () => { const b = await byPrefix('worked-', -1); await app.mouse.click({ x: b.x + 40, y: b.y + 10 }) }, [0, 55, 110, 165, 260], 3, 120)
  await run('chevron-worked-close', async () => pad(await byPrefix('worked-', -1), 20, 760, 220), async () => { const b = await byPrefix('worked-', -1); await app.mouse.click({ x: b.x + 40, y: b.y + 10 }) }, [0, 55, 110, 165, 260], 3, 120)
  const bubble = await byPrefix('user-bubble', 0).catch(() => null)
  if (bubble) {
    const hov = { x: bubble.x + bubble.width / 2, y: bubble.y + 10 }
    await run('bubble-hover-in', async () => pad(bubble, 16, bubble.width + 32, bubble.height + 56), () => app.mouse.move(hov), [0, 50, 100, 150, 200], 5)
    const cb = await byPrefix('user-copy', 0), copy = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 }
    await run('copy-check', async () => pad(bubble, 16, bubble.width + 32, bubble.height + 56), async () => { await app.mouse.move(copy); await app.mouse.click(copy) }, [0, 60, 125, 190, 250, 400], 3, 120)
    await run('bubble-hover-out', async () => pad(bubble, 16, bubble.width + 32, bubble.height + 56), () => app.mouse.move({ x: 1275, y: 815 }), [0, 50, 100, 150], 4)
  }
  // Request card entering as the thread opens (pointer navigation): approval and the activity strip collapse.
  await run('approval-open', async () => ({ x: 280, y: 440, w: 1000, h: 380 }), () => open(app, fx, 'Approve a command'), [0, 60, 125, 190, 260], 3, 400)
  await open(app, fx, 'Native subagents'); await sleep(600)
  await run('strip-collapse', async () => pad(await byPrefix('subagent-strip'), 16), async () => { const b = await byPrefix('subagent-strip'); await app.mouse.click({ x: b.x + 70, y: b.y + 20 }) }, [0, 55, 110, 165, 260], 3, 150)
  await run('strip-expand', async () => pad(await byPrefix('subagent-strip'), 16), async () => { const b = await byPrefix('subagent-strip'); await app.mouse.click({ x: b.x + 70, y: b.y + 20 }) }, [0, 55, 110, 165, 260], 3, 150)
  await open(app, fx, 'Native subagents'); await sleep(600)
  await open(app, fx, 'Review cancellation'); await sleep(600)
  await run('subagent-page', async () => ({ x: 280, y: 60, w: 1000, h: 140 }), async () => { await sleep(0) }, [0, 100], 2, 100)
  await shot('scroll-tail-before')
  await app.mouse.wheel({ x: 700, y: 400 }, 0, -900); await sleep(600)
  await shot('scroll-away')
} finally { await app.close() }
const lines: string[] = []
for (const s of sets) {
  const out = path.join(dir, `${s.name}--strip.png`)
  execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(Math.round(s.crop.x * 2)), String(Math.round(s.crop.y * 2)), String(Math.round(s.crop.w * 2)), String(Math.round(s.crop.h * 2)), String(s.cols), ...s.frames.flatMap(file => ['top:0', file])])
  lines.push(s.name)
}
writeFileSync(path.join(dir, 'README.txt'), `GPUIX motion P2 real-app strips (${theme}, reduced=${reduced}).\n${lines.join('\n')}\n`)
console.log(`ok ${dir}\n  ${lines.join('\n  ')}`)
process.exit(0)
