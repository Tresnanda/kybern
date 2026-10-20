// P4 motion strips (V-strip + V-cost + V-rm + V-kbd evidence) for the pages: Notes, Tasks, Pull requests, Usage, Settings, dialogs.
// One launch of the real app against the P4 scratch daemon (+ the visual settings proxy for pull requests and plan usage), under a
// paused automation clock stepped to every offset, one window screenshot per frame (visual strips only: never a timing run):
//   VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4 VISUAL_DAEMON_PORT=4373 bun visual/up.ts
//   VISUAL_SCRATCH=… VISUAL_DAEMON_PORT=4373 bun native/ui-lease.ts gpuix-p4 bun scripts/motion-p4-strips.ts [--theme dark|light|both] [--reduced 0|1|both] [--only a,b]
// Frames are cropped into one horizontal strip per item (swift render9-grid); `islands` is the number of cached-island renders seen up to
// each frame (a paint-only tween adds none between its first and last frame; a layout tween adds one per frame).
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { connect, readState } from '../visual/fixture.ts'
import { ids as startSettingsProxy } from '../visual/fixture.settings.ts'

const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const reduceds = arg('--reduced', '0') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const only = process.argv.includes('--only') ? new Set(arg('--only', '').split(',')) : null
const root = arg('--out', '/Users/mymac/projects/ade/previews/motion/gpuix-p4')
const SCRATCH = '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4'
const scratch = { KYBERN_DATA_DIR: `${SCRATCH}/data`, KYBERN_CLIENT_CONFIG_DIR: `${SCRATCH}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${SCRATCH}/credentials`, KYBERN_ENVIRONMENT_NAME: 'Development environment' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Crop = { x: number; y: number; w: number; h: number }

type StripSet = { name: string; frames: string[]; crop: Crop; counts: number[]; cost?: string; cols: number }

async function session(theme: string, reduced: string) {
  const state = readState()
  if (!state) throw new Error('no P4 scratch daemon (VISUAL_SCRATCH=…/motion-gpuix-p4 VISUAL_DAEMON_PORT=4373 bun visual/up.ts)')
  const client = await connect(state)
  await startSettingsProxy(client) // the mocking proxy: pull requests and plan usage; sets KYBERN_URL / KYBERN_TOKEN
  const proxyPort = readState()!.port
  await fetch(`http://127.0.0.1:${proxyPort}/mode?value=s9-rich`)
  const notes = (await client.call('notes.list', {})).notes
  const tasks = (await client.call('tasks.items.list', {})).tasks
  const noteId = (title: string) => notes.find(n => n.title === title)!.id
  const taskId = (title: string) => tasks.find(x => x.title === title)!.id
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`
  const dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${SCRATCH}/data/gpuix-ui.json`, '{}')
  rmSync(`${SCRATCH}/client`, { recursive: true, force: true })
  const env = { ...scratch, KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_URL: process.env.KYBERN_URL!, KYBERN_TOKEN: process.env.KYBERN_TOKEN!, KYBERN_WINDOW_SIZE: '1280x820' }
  const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_DEBUG_ISLANDS: '1', ...env })
  const a = f.app
  const sets: StripSet[] = []
  const shot = async (name: string) => { await sleep(30); const file = path.join(dir, `${name}.png`); await a.screenshot({ path: file }); return file }
  const center = async (id: string) => a.getByTestId(id).center()
  const click = async (id: string) => { const c = await center(id); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c) }
  const press = (k: string) => a.getByTestId('app-ready').press(k)
  const focus = async (id: string) => { await a.call('focus', { elementId: (await a.getByTestId(id).element()).id }) }
  const park = { x: 1275, y: 815 }
  const ff = (ms: number) => a.clock.fastForward(ms)
  const waitFor = async (id: string) => { for (let i = 0; i < 120; i++) { try { return await center(id) } catch { await sleep(250) } } throw new Error(`no ${id}`) }
  /** Trigger under a paused clock, let real-time effects (RPC, state) land, then step the tween frame by frame. */
  const run = async (id: string, crop: Crop, trigger: () => Promise<unknown>, offsets: number[], opts: { settle?: number; cols?: number; undo?: () => Promise<unknown>; after?: number } = {}) => {
    const { settle = 250, cols = Math.min(offsets.length, 4), undo, after = 700 } = opts
    if (only && !only.has(id.replace(/-\d+$/, '')) && !only.has(id)) { await trigger(); await sleep(settle); await ff(after); return }
    await trigger(); await sleep(settle)
    const frames: string[] = [], seen: number[] = []
    let at = 0
    for (const o of offsets) { if (o > at) await ff(o - at); at = o; frames.push(await shot(`${id}-${String(o).padStart(3, '0')}`)); seen.push(f.islandRenders()) }
    await ff(after)
    let cost: string | undefined
    if (undo) {
      // V-cost: the same tween again with no screenshots (a screenshot itself renders the islands).
      await undo(); await sleep(250); await ff(700); await sleep(120)
      await trigger(); await sleep(settle)
      const before = f.islandRenders(), total = Math.max(...offsets)
      for (let i = 0; i < 4; i++) await ff(total / 4)
      await sleep(60)
      cost = `${f.islandRenders() - before} island renders over a ${total} ms tween (no screenshots)`
      await ff(after)
    }
    sets.push({ name: id, frames, crop, counts: seen, cost, cols })
  }
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await sleep(2500)
    await a.getByTestId('rail-home').click(); await sleep(600)
    await a.mouse.move(park); await sleep(300)
    await a.clock.pause()
    const ctx = { a, f, run, click, press, focus, center, waitFor, ff, sleep, park, noteId, taskId, client, theme, reduced }
    await scenes(ctx)
    await a.clock.resume()
  } finally { await f.close(); client.close?.() }
  const lines: string[] = []
  for (const s of sets) {
    const c = { x: Math.round(s.crop.x), y: Math.round(s.crop.y), w: Math.round(Math.min(s.crop.w, 1280)), h: Math.round(Math.min(s.crop.h, 820)) }
    c.x = Math.max(0, Math.min(c.x, 1280 - c.w)); c.y = Math.max(0, Math.min(c.y, 820 - c.h))
    const out = path.join(dir, `${s.name}-strip.png`)
    const scale = 2
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(c.x * scale), String(c.y * scale), String(c.w * scale), String(c.h * scale), String(s.cols), ...s.frames.flatMap(file => ['top:0', file])])
    const width = c.w * scale * s.cols + 8 * (s.cols - 1)
    if (width < 1000) execFileSync('sips', ['--resampleWidth', String(Math.round(width * Math.min(4, 1400 / width))), out], { stdio: 'ignore' })
    lines.push(`${s.name}: ${s.cost ?? 'cost not measured'}; island renders per screenshot frame ${s.counts.join('/')}`)
  }
  writeFileSync(path.join(dir, 'README.txt'), `GPUIX motion P4 ${label}.\n${lines.join('\n')}\n`)
  console.log(`ok ${label}\n  ${lines.join('\n  ')}`)
}

type Ctx = {
  a: Awaited<ReturnType<typeof launchFixture>>['app']
  f: Awaited<ReturnType<typeof launchFixture>>
  run: (id: string, crop: Crop, trigger: () => Promise<unknown>, offsets: number[], opts?: { settle?: number; cols?: number; undo?: () => Promise<unknown>; after?: number }) => Promise<void>
  click: (id: string) => Promise<void>
  press: (k: string) => Promise<unknown>
  focus: (id: string) => Promise<void>
  center: (id: string) => Promise<{ x: number; y: number }>
  waitFor: (id: string) => Promise<{ x: number; y: number }>
  ff: (ms: number) => Promise<unknown>
  sleep: (ms: number) => Promise<unknown>
  park: { x: number; y: number }
  noteId: (title: string) => string
  taskId: (title: string) => string
  client: Awaited<ReturnType<typeof connect>>
  theme: string
  reduced: string
}

const WIN: Crop = { x: 0, y: 0, w: 1280, h: 820 }
const dwell = async (c: Ctx, ms = 700) => { await c.sleep(300); await c.ff(ms) }
async function scenes(c: Ctx) {
  const { a, run, click, press, focus, center, waitFor, ff, sleep, park, noteId, taskId, client } = c
  const rest = async () => { await a.mouse.move(park); await sleep(200); await ff(500) }
  const page = async (id: string) => { await click(`rail-${id}`); await sleep(700); await ff(700); await rest() }
  const all = (id: string) => (only && !only.has(id)) ? true : false
  void all
  // ─── Notes ─────────────────────────────────────────────────────────────
  await run('gallery-enter', { x: 52, y: 46, w: 1228, h: 480 }, () => click('rail-notes'), [0, 40, 80, 120, 170, 250], { cols: 3 })
  await rest()
  await run('gallery-filter', { x: 52, y: 46, w: 1228, h: 480 }, () => click('notes-filter-global'), [0, 40, 80, 120, 170, 250], { cols: 3, undo: () => click('notes-filter-all') })
  await click('notes-filter-all'); await dwell(c); await rest()
  const brief = `note-card-${noteId('Sprint planning')}`
  const card = await waitFor(brief)
  await run('note-lift', { x: card.x - 160, y: card.y - 90, w: 320, h: 200 }, async () => { await a.mouse.move(card) }, [0, 35, 70, 105, 140, 200], { cols: 3, undo: rest })
  await rest()
  await run('note-open', { x: 52, y: 46, w: 1228, h: 520 }, () => click(`note-card-${noteId('Design review notes')}`), [0, 40, 80, 120, 160, 250], { cols: 3, settle: 500 })
  await rest()
  // banner after the note is open: another client deletes it (the banner is not part of the page's own entrance)
  await sleep(600); await ff(900)
  await run('note-banner', { x: 52, y: 46, w: 1228, h: 140 }, async () => { await client.call('notes.delete', { id: noteId('Design review notes') }) }, [0, 40, 80, 120, 180, 250], { cols: 3, settle: 600 })
  await client.call('notes.restore', { id: noteId('Design review notes') }); await sleep(500); await ff(700)
  // save status: the label swaps once when the save settles
  await run('note-save-status', { x: 400, y: 100, w: 520, h: 120 }, async () => { await a.getByTestId('note-title').fill('Design review notes · edited'); await sleep(200); await press('cmd-s') }, [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 600 })
  await press('escape'); await sleep(500); await ff(700)
  await rest()
  // pointer delete from the editor's menu lands on a gallery whose card fades out; Undo brings it back
  await click(`note-card-${noteId('Scratchpad')}`); await sleep(800); await ff(800); await rest()
  await run('note-delete', { x: 52, y: 46, w: 1228, h: 480 }, async () => { await click('note-menu-more'); await sleep(300); await ff(400); await click('note-delete') }, [0, 40, 80, 120, 170, 250], { cols: 3, settle: 600 })
  await run('note-restore', { x: 52, y: 46, w: 1228, h: 480 }, async () => { await client.call('notes.restore', { id: noteId('Scratchpad') }) }, [0, 40, 80, 120, 170, 250], { cols: 3, settle: 500 })
  // keyboard: Enter on a focused card opens the note at once
  await rest()
  await run('kbd-note-open', { x: 52, y: 46, w: 1228, h: 520 }, async () => { const id = `note-card-${noteId('Design review notes')}`; await focus(id); await a.getByTestId(id).press('enter') }, [0, 100], { cols: 2, settle: 500 })
  await press('escape'); await sleep(500); await ff(700)

  // ─── Tasks ─────────────────────────────────────────────────────────────
  await run('tasks-page', { x: 52, y: 46, w: 1228, h: 420 }, () => click('rail-tasks'), [0, 40, 80, 160, 250], { cols: 3 })
  await rest()
  const first = taskId('Fix sidebar collapse jitter on resize'), second = taskId('Ship notes image blocks')
  const row = await waitFor(`task-row-${first}`)
  await run('task-glyph-check', { x: 308, y: row.y - 24, w: 360, h: 48 }, async () => { await a.mouse.move(row) }, [0, 20, 40, 60, 80, 120], { cols: 3, undo: rest })
  await rest()
  await a.mouse.move(row); await sleep(200); await ff(300)
  await click(`task-select-${first}`); await sleep(300); await ff(700)
  const row2 = await waitFor(`task-row-${second}`); await a.mouse.move(row2); await sleep(200); await ff(300)
  await rest()
  await click(`task-row-${first}`).catch(() => {})
  await press('escape'); await sleep(300); await ff(700)
  const bar = { x: 308, y: 600, w: 700, h: 220 }
  await a.mouse.move(row); await sleep(200); await ff(300)
  await run('selection-bar-in', bar, () => click(`task-select-${first}`), [0, 40, 80, 120, 160, 250], { cols: 3, settle: 300 })
  await run('selection-bar-out', bar, () => click('task-selection-clear'), [0, 30, 60, 90, 140, 250], { cols: 3, settle: 300 })
  await rest()
  await a.mouse.move(row); await sleep(200); await ff(300); await click(`task-select-${first}`); await sleep(300); await ff(700); await rest()
  await run('kbd-selection-bar-out', bar, () => press('escape'), [0, 100], { cols: 2, settle: 300 })
  await rest()
  // batch / run dock: pointer opens and hides with motion, ⌘↵ shows it at once
  await a.mouse.move(row); await sleep(200); await ff(300); await click(`task-select-${first}`); await sleep(300); await ff(700)
  const dock = { x: 308, y: 380, w: 972, h: 440 }
  await run('run-dock-in', dock, () => click('task-batch-open'), [0, 50, 100, 150, 200, 260, 400], { cols: 4, settle: 600 })
  await run('run-dock-out', dock, () => click('task-composer-close'), [0, 40, 80, 120, 160, 250], { cols: 3, settle: 400 })
  await press('escape'); await sleep(300); await ff(700); await rest()
  await a.mouse.move(row); await sleep(200); await ff(300); await click(`task-select-${first}`); await sleep(300); await ff(700); await rest()
  await run('kbd-run-dock', dock, () => press('cmd-enter'), [0, 100], { cols: 2, settle: 600 })
  await press('escape'); await sleep(300); await ff(700)
  await click('task-composer-close').catch(() => {}); await sleep(300); await ff(700)
  await press('escape'); await sleep(300); await ff(700); await rest()
  // status glyph swap and count pop from another client changing a task's status
  await run('task-status-swap', { x: 308, y: 46, w: 972, h: 330 }, async () => { await client.call('tasks.items.update', { id: first, status: 'done' }) }, [0, 40, 80, 120, 170, 250, 400], { cols: 4, settle: 500 })
  await client.call('tasks.items.update', { id: first, status: 'todo' }); await sleep(500); await ff(900)
  // sidebar: Projects chevron and the rows that fold away
  await run('tasks-projects-collapse', { x: 52, y: 200, w: 256, h: 360 }, () => click('task-projects-toggle'), [0, 55, 110, 165, 220, 300], { cols: 3, undo: () => click('task-projects-toggle') })
  await click('task-projects-toggle'); await sleep(300); await ff(800); await rest()
  // task page opened by a click rises in; Enter shows it at once; the back arrow has no motion
  await run('task-page-open', { x: 308, y: 46, w: 972, h: 500 }, () => click(`task-drag-${second}`), [0, 40, 80, 120, 160, 250], { cols: 3, settle: 500 })
  await rest()
  await click('task-back'); await sleep(400); await ff(800); await rest()
  await run('kbd-task-page-open', { x: 308, y: 46, w: 972, h: 500 }, async () => { await focus(`task-row-${second}`); await a.getByTestId(`task-row-${second}`).press('enter') }, [0, 100], { cols: 2, settle: 500 })
  await press('escape'); await sleep(400); await ff(800)

  // ─── Pull requests ─────────────────────────────────────────────────────
  await page('pulls')
  await run('pr-filter-pill', { x: 52, y: 46, w: 520, h: 200 }, () => click('pr-filter-merged'), [0, 50, 100, 150, 200, 250, 400], { cols: 4, settle: 500, undo: () => click('pr-filter-open') })
  await click('pr-filter-open'); await sleep(500); await ff(800); await rest()
  await run('pr-detail-open', { x: 52, y: 46, w: 1228, h: 480 }, () => click('pr-row-108'), [0, 50, 100, 150, 250], { cols: 3, settle: 700 })
  await rest()
  await run('pr-tab-changes', { x: 52, y: 46, w: 1228, h: 480 }, () => click('pr-tab-changes'), [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 700, undo: () => click('pr-tab-summary') })
  await run('pr-tab-timeline', { x: 52, y: 46, w: 1228, h: 480 }, () => click('pr-tab-timeline'), [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 700 })
  await click('pr-tab-summary'); await sleep(500); await ff(800); await rest()
  await run('kbd-pr-tab', { x: 52, y: 46, w: 1228, h: 480 }, async () => { await focus('pr-tab-summary'); await a.getByTestId('pr-tab-summary').press('right') }, [0, 100], { cols: 2, settle: 600 })
  await click('pr-tab-summary'); await sleep(500); await ff(800); await rest()
  await run('pr-copy-link', { x: 700, y: 46, w: 580, h: 50 }, () => click('pr-copy-link'), [0, 60, 125, 190, 250, 400], { cols: 3, settle: 300 })
  await ff(1700); await rest()
  await run('pr-copy-link-back', { x: 700, y: 46, w: 580, h: 50 }, async () => {}, [0, 60, 125, 190, 250, 400], { cols: 3, settle: 300 })

  // ─── Usage ─────────────────────────────────────────────────────────────
  await page('usage')
  await run('usage-enter', WIN, async () => {}, [0, 100, 200, 300, 450], { cols: 3, settle: 100 })
  await run('usage-period', { x: 52, y: 46, w: 1228, h: 700 }, async () => { await click('usage-period'); await sleep(300); await ff(400); await click('usage-period-7') }, [0, 60, 125, 190, 250, 400], { cols: 3, settle: 600 })
  await run('usage-group', { x: 52, y: 380, w: 1228, h: 440 }, () => click('usage-group-model'), [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 600 })

  // ─── Settings ──────────────────────────────────────────────────────────
  await run('settings-open', { x: 0, y: 46, w: 1280, h: 560 }, () => click('rail-settings'), [0, 300, 450], { cols: 3, settle: 500 })
  await ff(800)
  await run('settings-tab', { x: 0, y: 46, w: 1280, h: 560 }, () => click('settings-tab-appearance'), [0, 40, 80, 120, 170, 250, 400], { cols: 4, settle: 400, undo: () => click('settings-tab-general') })
  await click('settings-tab-general'); await sleep(400); await ff(800)
  await run('kbd-settings-tab', { x: 0, y: 46, w: 1280, h: 560 }, async () => { await focus('settings-tab-appearance'); await a.getByTestId('settings-tab-appearance').press('enter') }, [0, 100], { cols: 2, settle: 400 })
  await click('settings-tab-general'); await sleep(400); await ff(800); await rest()
  await run('settings-select', { x: 700, y: 120, w: 580, h: 300 }, () => click('settings-default-agent'), [0, 60, 125, 190, 250, 400], { cols: 3, settle: 400 })
  await press('escape'); await sleep(300); await ff(800)
  await click('settings-tab-background'); await sleep(500); await ff(800); await rest()
  await click('settings-back'); await sleep(500); await ff(800)
}

for (const theme of themes) for (const reduced of reduceds) await session(theme, reduced)
process.exit(0)
