// P3 motion strips on the real app (the dock items a lab cannot stand in for): the seeded visual-pair fixture on a scratch daemon,
// paused clock, one automation screenshot per offset. Needs VISUAL_SCRATCH under gpuix-scratch and a fixed daemon port:
//   NAPI_RS_NATIVE_LIBRARY_PATH=$PWD/native/build/gpuix-native.darwin-arm64.node \
//   VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p3 VISUAL_DAEMON_PORT=4372 \
//     bun native/ui-lease.ts gpuix-p3 bun scripts/motion-p3-app.ts [--theme dark|light] [--reduced 0|1] [--only a,b] [--cost 1]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR, connect, readState, seed, startDaemon } from '../visual/fixture.ts'
import { loadAreaFixtures } from '../visual/load.ts'
import { open } from '../visual/screens/conversation.gpuix.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const theme = arg('--theme', 'dark'), reduced = arg('--reduced', '0'), only = arg('--only', '').split(',').filter(Boolean)
const cost = arg('--cost', '0') === '1'
const dir = path.join(arg('--out', '/Users/mymac/projects/ade/previews/motion/gpuix-p3'), `app-${theme}-${reduced === '1' ? 'reduced' : 'normal'}${cost ? '-cost' : ''}`)
mkdirSync(dir, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const log = (m: string) => console.error(`[p3 ${new Date().toISOString().slice(11, 19)}] ${m}`)
log('daemon')
let state = await startDaemon(true)
log('seed'); await seed(state); state = readState()!; log('seeded')
const client = await connect(state)
const extra: Record<string, unknown> = {}
for (const [area, f] of Object.entries(await loadAreaFixtures())) if (f.ids) extra[area] = await f.ids(client)
client.close?.()
state = readState()!
const fx = { extra, notes: {}, tasks: {}, taskKeys: {} } as never
rmSync(path.join(DATA_DIR, 'gpuix-ui.json'), { force: true }); rmSync(CLIENT_DIR, { recursive: true, force: true })
log('launch')
const fixture = await launchFixture(path.resolve(import.meta.dir, '../src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_DEBUG_ISLANDS: '1', KYBERN_ENVIRONMENT_NAME: 'Development environment', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_REDUCED_MOTION: reduced })
const app = fixture.app
type Crop = { x: number; y: number; w: number; h: number }
const sets: { name: string; frames: string[]; crop: Crop; cols: number }[] = []
const costs: string[] = []
const shot = async (name: string) => { await sleep(30); const file = path.join(dir, `${name}.png`); await app.screenshot({ path: file }); return file }
const byPrefix = async (prefix: string, nth = 0, exclude = '') => {
  const nodes = (await app.getByType('div').all()).filter(n => n.testId?.startsWith(prefix) && (!exclude || !n.testId.includes(exclude)) && n.bounds && n.bounds.height > 0)
  const node = nodes.at(nth); if (!node?.bounds) throw new Error(`no ${prefix}* (${nodes.length})`); return { ...node.bounds, testId: node.testId! }
}
const center = async (id: string) => { try { const b = await app.getByTestId(id).bounds(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } } catch (error) { const ids = (await app.getByType('div').all()).filter(n => /^(dock-|terminal-|preview-)/.test(n.testId ?? '')).map(n => n.testId).join(' '); throw new Error(`no element ${id}: ${error}; present: ${ids}`) } }
const click = async (id: string) => { const c = await center(id); await app.mouse.move(c); await app.mouse.down(c); await app.mouse.up(c) }
const key = async (k: string) => { await app.call('keyDown', { key: k }) }
const press = async (chord: string) => { await app.getByTestId('app-ready').press(chord) }
const DOCK: Crop = { x: 640, y: 0, w: 640, h: 820 }, TABS: Crop = { x: 640, y: 40, w: 640, h: 70 }, PANE: Crop = { x: 640, y: 46, w: 640, h: 420 }
/** Trigger under a paused clock, wait for the real-time effects (RPC, state), then step the tween frame by frame; `crops` cut one strip each. */
const run = async (id: string, crops: Crop[], trigger: () => Promise<void>, offsets: number[], cols = 4, settleMs = 250) => {
  log(`run ${id}`)
  if (only.length && !only.some(o => id.startsWith(o))) { await trigger(); await sleep(settleMs); return }
  await app.clock.pause()
  await trigger(); await sleep(settleMs)
  if (cost) {
    // V-cost: the tween stepped with no screenshots (a screenshot itself renders the islands); cached-island renders it adds.
    const total = Math.max(...offsets), i0 = fixture.islandRenders()
    for (let i = 0; i < 4; i++) await app.clock.fastForward(total / 4)
    await sleep(60)
    costs.push(`${id}: ${fixture.islandRenders() - i0} island renders over ${total} ms (no screenshots)`)
    await app.clock.resume(); await sleep(500); return
  }
  const frames: string[] = []
  let now = 0
  for (const o of offsets) { if (o > now) await app.clock.fastForward(o - now); now = o; frames.push(await shot(`${id}-${String(o).padStart(3, '0')}`)) }
  await app.clock.resume(); await sleep(600)
  crops.forEach((crop, n) => sets.push({ name: crops.length > 1 ? `${id}-${n}` : id, frames, crop, cols }))
}
const T = [0, 40, 80, 120, 160, 250, 400]
try {
  log('waiting for app'); await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await sleep(1800); log('ready')
  // The dock thread of the seeded fixture ("Dock visual review"), dock closed to start.
  await app.getByTestId(`thread-${(extra.dock as { thread: string }).thread}`).click(); await sleep(1500)
  if (await app.getByTestId('dock-tabs').count()) { await click('dock-collapse'); await sleep(900) }
  // P3.2: open and close by pointer (width spring + content fade), then by the shortcut (instant).
  await run('dock-open', [DOCK], () => click('dock-toggle'), [0, 50, 100, 150, 200, 300, 450], 4, 120)
  await run('dock-close', [DOCK], () => click('dock-collapse'), [0, 50, 100, 150, 200, 300, 450], 4, 120)
  await run('dock-kbd-open', [DOCK], () => press('cmd-j'), [0, 40, 100], 3, 120)
  await run('dock-kbd-close', [DOCK], () => press('cmd-j'), [0, 40, 100], 3, 120)
  await click('dock-toggle'); await sleep(1500)
  // P3.4 + P3.1: a panel added from the + menu (tab grows in, pane enters), then switched by pointer, then closed.
  await click('dock-add'); await sleep(500)
  await run('tab-add-agents', [TABS, PANE], () => click('dock-add-agents'), [0, 70, 140, 210, 300, 450, 700], 4, 300)
  await click('dock-add'); await sleep(500)
  await run('tab-add-explorer', [TABS, PANE], () => click('dock-add-explorer'), [0, 40, 80, 120, 160, 250, 400], 4, 200)
  await run('pane-to-agents', [PANE, TABS], () => click('dock-tab-agents'), [0, 40, 80, 120, 160, 250, 400], 4, 200)
  await run('pane-to-explorer', [PANE], () => click('dock-tab-explorer'), [0, 40, 80, 120, 160, 250, 400], 4, 200)
  await run('tab-close-explorer', [TABS, PANE], () => click('dock-tab-close-explorer'), [0, 40, 80, 120, 160, 250, 400], 4, 200)
  // V-kbd: arrow keys between tabs change the pane at once.
  await click('dock-add'); await sleep(400); await click('dock-add-explorer'); await sleep(1500)
  await app.getByTestId('dock-tab-agents').click(); await sleep(600)
  await run('pane-kbd', [PANE], async () => { await app.call('focus', { elementId: (await app.getByTestId('dock-tab-agents').element()).id }); await key('right') }, [0, 40, 100], 3, 200)
  await click('dock-tab-close-explorer'); await sleep(600)
  // P3.9: terminal tabs.
  await click('dock-add'); await sleep(400); await click('dock-add-terminal'); await sleep(2500)
  await run('terminal-new-tab', [PANE], () => click('terminal-new'), [0, 40, 80, 120, 160, 250, 400], 4, 1500)
  const firstTab = await byPrefix('terminal-tab-', 0, 'close')
  await run('terminal-tab-switch', [PANE], async () => { const c = { x: firstTab.x + firstTab.width / 2, y: firstTab.y + firstTab.height / 2 }; await app.mouse.move(c); await app.mouse.down(c); await app.mouse.up(c) }, [0, 40, 80, 120, 160, 250], 3, 300)
  await app.mouse.move({ x: 1000, y: 700 }); await sleep(300)
  await run('terminal-tab-hover', [{ x: 640, y: 90, w: 400, h: 60 }], async () => { const b = await byPrefix('terminal-tab-', 0, 'close'); await app.mouse.move({ x: b.x + 14, y: b.y + 14 }) }, [0, 30, 60, 100, 150, 250], 6, 150)
  await run('terminal-tab-unhover', [{ x: 640, y: 90, w: 400, h: 60 }], () => app.mouse.move({ x: 1000, y: 700 }), [0, 30, 60, 100, 150, 250], 6, 150)
  await click('dock-tab-close-terminal'); await sleep(800)
  // P3.7: an Explorer file opened by click enters as a pane.
  await click('dock-add'); await sleep(400); await click('dock-add-explorer'); await sleep(1200)
  await click('dock-file-src'); await sleep(800)
  await run('explorer-file', [PANE], () => click('dock-file-src/dock-example.ts'), [0, 40, 80, 120, 160, 250, 400], 4, 300)
  await click('dock-tab-close-explorer'); await sleep(600)
  // P3.5: the Agents tree on a thread with native subagents.
  await open(app, fx, 'Native subagents'); await sleep(800)
  if (!await app.getByTestId('dock-tabs').count()) await click('dock-toggle')
  await sleep(1200)
  if (!await app.getByTestId('dock-tab-agents').count()) { await click('dock-add'); await sleep(400); await click('dock-add-agents') } else await click('dock-tab-agents')
  await sleep(1500)
  const agent = await byPrefix('dock-agent-', 0, 'tree')
  await run('agents-detail-open', [{ x: 640, y: 80, w: 640, h: 420 }], async () => { await app.mouse.move({ x: agent.x + 200, y: agent.y + 20 }); await app.mouse.down({ x: agent.x + 200, y: agent.y + 20 }); await app.mouse.up({ x: agent.x + 200, y: agent.y + 20 }) }, [0, 55, 110, 165, 220, 320], 3, 300)
  await run('agents-detail-close', [{ x: 640, y: 80, w: 640, h: 420 }], async () => { await app.mouse.move({ x: agent.x + 200, y: agent.y + 20 }); await app.mouse.down({ x: agent.x + 200, y: agent.y + 20 }); await app.mouse.up({ x: agent.x + 200, y: agent.y + 20 }) }, [0, 55, 110, 165, 220, 320], 3, 300)
  if (process.argv.includes('--probe')) console.log((await app.getByType('div').all()).filter(n => /^(dock-|terminal-|preview-)/.test(n.testId ?? '')).map(n => `${n.testId} ${JSON.stringify(n.bounds)}`).join('\n'))
} finally { await fixture.close() }
if (cost) { writeFileSync(path.join(dir, 'COST.txt'), costs.join('\n') + '\n'); console.log(costs.join('\n')); process.exit(0) }
const lines: string[] = []
for (const s of sets) {
  const out = path.join(dir, `${s.name}--strip.png`)
  execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(Math.round(s.crop.x * 2)), String(Math.round(s.crop.y * 2)), String(Math.round(s.crop.w * 2)), String(Math.round(s.crop.h * 2)), String(s.cols), ...s.frames.flatMap(file => ['top:0', file])])
  lines.push(s.name)
}
writeFileSync(path.join(dir, 'README.txt'), `GPUIX motion P3 real-app strips (${theme}, reduced=${reduced}).\n${lines.join('\n')}\n`)
console.log(`ok ${dir}\n  ${lines.join('\n  ')}`)
process.exit(0)
