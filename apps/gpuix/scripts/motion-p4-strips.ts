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
const groups = process.argv.includes('--groups') ? new Set(process.argv[process.argv.indexOf('--groups') + 1]!.split(',')) : null
const only = process.argv.includes('--only') ? new Set(arg('--only', '').split(',')) : null
const root = arg('--out', '/Users/mymac/projects/ade/previews/motion/gpuix-p4')
const SCRATCH = process.env.VISUAL_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4'
const scratch = { KYBERN_DATA_DIR: `${SCRATCH}/data`, KYBERN_CLIENT_CONFIG_DIR: `${SCRATCH}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${SCRATCH}/credentials`, KYBERN_ENVIRONMENT_NAME: 'Development environment' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Crop = { x: number; y: number; w: number; h: number }

type StripSet = { name: string; frames: string[]; crop: Crop; counts: number[]; cost?: string; cols: number }


/** A WebSocket front for the app: forwards everything, can delay a method (real time) and, once a merge went through, answers pull request reads as merged. */
function interceptor(upstream: string, delays: Map<string, number>) {
  let merged = false
  const server = Bun.serve<{ up: WebSocket; queued: string[]; methods: Map<string, string> }>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, srv) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') { const target = new URL(req.url); target.port = new URL(upstream).port; return fetch(new Request(target, req)) }
      const up = new WebSocket(upstream, { headers: { origin: 'tauri://localhost' } } as never)
      if (srv.upgrade(req, { data: { up, queued: [], methods: new Map() } })) return
      up.close(); return new Response('no', { status: 404 })
    },
    websocket: {
      open(ws) {
        ws.data.up.onmessage = e => {
          const text = String(e.data)
          if (merged) {
            try {
              const msg = JSON.parse(text)
              const method = msg.id !== undefined ? ws.data.methods.get(String(msg.id)) : undefined
              if (method === 'github.pr.detail' && msg.result?.pull_request) { msg.result.pull_request.state = 'MERGED'; msg.result.merged_by = 'reviewer'; msg.result.merged_at = new Date().toISOString(); ws.send(JSON.stringify(msg)); return }
            } catch { /* forward as is */ }
          }
          ws.send(text)
        }
        ws.data.up.onopen = () => { for (const m of ws.data.queued) ws.data.up.send(m); ws.data.queued = [] }
        ws.data.up.onclose = () => ws.close()
      },
      message(ws, raw) {
        const text = String(raw), req = JSON.parse(text)
        ws.data.methods.set(String(req.id), req.method)
        if (req.method === 'github.pr.action' && req.params?.action === 'merge') merged = true
        const send = () => { if (ws.data.up.readyState === WebSocket.OPEN) ws.data.up.send(text); else ws.data.queued.push(text) }
        const delay = delays.get(req.method)
        if (delay) setTimeout(send, delay); else send()
      },
      close(ws) { ws.data.up.close() },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}/ws`, stop: () => server.stop(true), reset: () => { merged = false } }
}

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
  const delays = new Map<string, number>()
  const front = interceptor(`ws://127.0.0.1:${proxyPort}/ws`, delays)
  const env = { ...scratch, KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_URL: front.url, KYBERN_TOKEN: process.env.KYBERN_TOKEN!, KYBERN_WINDOW_SIZE: '1280x820' }
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
    try {
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
    } catch (e) { console.log('FAILED', id, String(e).slice(0, 160)); await a.mouse.move(park).catch(() => {}); await ff(300).catch(() => {}) }
  }
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await sleep(2500)
    await a.getByTestId('rail-home').click(); await sleep(600)
    await a.mouse.move(park); await sleep(300)
    await a.clock.pause()
    const ctx = { a, f, run, click, press, focus, center, waitFor, ff, sleep, park, noteId, taskId, client, theme, reduced, delays, front }
    await scenes(ctx)
    await a.clock.resume()
  } finally { await f.close(); front.stop(); client.close?.() }
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
  delays: Map<string, number>
  front: { reset: () => void }
}

const WIN: Crop = { x: 0, y: 0, w: 1280, h: 820 }
const dwell = async (c: Ctx, ms = 700) => { await c.sleep(300); await c.ff(ms) }
async function scenes(c: Ctx) {
  const step = async (name: string, fn: () => Promise<void>) => { if (groups && !groups.has(name)) return; try { await fn() } catch (e) { console.log('FAILED group', name, String(e).slice(0, 160)); await c.a.mouse.move(c.park).catch(() => {}) } }
  const { a, run, click, press, focus, center, waitFor, ff, sleep, park, noteId, taskId, client, delays, front } = c
  const rest = async () => { await a.mouse.move(park); await sleep(200); await ff(500) }
  const page = async (id: string) => { await click(`rail-${id}`); await sleep(700); await ff(700); await rest() }
  const settleAll = async (ms = 500) => { await sleep(ms); await ff(800); await rest() }
  // ─── Notes ─────────────────────────────────────────────────────────────
  await step('Notes', async () => {
    await run('gallery-enter', { x: 52, y: 46, w: 1228, h: 480 }, () => click('rail-notes'), [0, 40, 80, 120, 170, 250], { cols: 3 })
    await rest()
    await run('gallery-filter', { x: 52, y: 46, w: 1228, h: 480 }, () => click('notes-filter-global'), [0, 40, 80, 120, 170, 250], { cols: 3, undo: () => click('notes-filter-all') })
    await click('notes-filter-all'); await settleAll(300)
    const card = await waitFor(`note-card-${noteId('Sprint planning')}`)
    await run('note-lift', { x: card.x - 240, y: card.y - 110, w: 480, h: 280 }, async () => { await a.mouse.move(card) }, [0, 35, 70, 105, 140, 200], { cols: 3, undo: rest })
    await rest()
    await run('note-open', { x: 52, y: 46, w: 1228, h: 520 }, () => click(`note-card-${noteId('Sprint planning')}`), [0, 40, 80, 120, 160, 250], { cols: 3, settle: 500 })
    await rest()
    // banner after the note is open: another client deletes it (the banner is not part of the page's own entrance)
    await settleAll(600)
    await run('note-banner', { x: 52, y: 46, w: 1228, h: 240 }, async () => { await client.call('notes.delete', { id: noteId('Sprint planning') }) }, [0, 40, 80, 120, 180, 250], { cols: 3, settle: 600 })
    await client.call('notes.restore', { id: noteId('Sprint planning') }); await settleAll(500)
    // save status: the label swaps once when the save settles
    await run('note-save-status', { x: 400, y: 100, w: 520, h: 120 }, async () => { await a.getByTestId('note-title').fill('Sprint planning · edited'); await sleep(200); await press('cmd-s') }, [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 600 })
    await a.getByTestId('note-title').fill('Sprint planning'); await sleep(200); await press('cmd-s'); await settleAll(500)
    await press('escape'); await settleAll(500)
    // a pointer delete from the editor's menu lands on a gallery whose card fades out; the restore brings a fresh card back
    const doomed = noteId('Release checklist 0.9.2')
    await click(`note-card-${doomed}`); await settleAll(800)
    await run('note-delete', { x: 52, y: 46, w: 1228, h: 760 }, async () => { await click('note-menu-more'); await sleep(300); await ff(400); await click('note-delete') }, [0, 40, 80, 120, 170, 250], { cols: 3, settle: 600 })
    await run('note-restore', { x: 52, y: 46, w: 1228, h: 760 }, async () => { await client.call('notes.restore', { id: doomed }) }, [0, 40, 80, 120, 170, 250], { cols: 3, settle: 500 })
    await rest()
    await run('kbd-note-open', { x: 52, y: 46, w: 1228, h: 520 }, async () => { const id = `note-card-${noteId('Sprint planning')}`; await focus(id); await a.getByTestId(id).press('enter') }, [0, 100], { cols: 2, settle: 500 })
    await press('escape'); await settleAll(500)
  })
  // ─── Tasks ─────────────────────────────────────────────────────────────
  await step('Tasks', async () => {
    await run('tasks-page', { x: 52, y: 46, w: 1228, h: 420 }, () => click('rail-tasks'), [0, 40, 80, 160, 250], { cols: 3 })
    await rest()
    // The first two rows on screen (a long seeded list, or an earlier run's status changes, can push the fixture's own tasks out of view).
    const onScreen: string[] = []
    for (const n of await a.getByType('div').all()) if (n.testId?.startsWith('task-row-') && n.bounds && n.bounds.y > 80 && n.bounds.y < 560) onScreen.push(n.testId.slice(9))
    const first = onScreen[0] ?? taskId('Fix sidebar collapse jitter on resize'), second = onScreen[1] ?? taskId('Ship notes image blocks')
    const row = await waitFor(`task-row-${first}`)
    await run('task-glyph-check', { x: 308, y: row.y - 24, w: 360, h: 48 }, async () => { await a.mouse.move(row) }, [0, 20, 40, 60, 80, 120], { cols: 3, undo: rest })
    await rest()
    const bar = { x: 308, y: 600, w: 700, h: 220 }
    const pick = async () => { await a.mouse.move(row); await sleep(200); await ff(300); await click(`task-select-${first}`); await sleep(300) }
    await a.mouse.move(row); await sleep(200); await ff(300)
    await run('selection-bar-in', bar, () => click(`task-select-${first}`), [0, 40, 80, 120, 160, 250], { cols: 3, settle: 300 })
    await run('selection-bar-out', bar, () => click('task-selection-clear'), [0, 30, 60, 90, 140, 250], { cols: 3, settle: 300 })
    await rest()
    await pick(); await settleAll(400)
    await run('kbd-selection-bar-out', bar, () => press('escape'), [0, 100], { cols: 2, settle: 300 })
    await rest()
    // batch / run dock: pointer opens and hides with motion, ⌘↵ shows it at once
    const dock = { x: 308, y: 380, w: 972, h: 440 }
    await pick(); await settleAll(400)
    await run('run-dock-in', dock, () => click('task-batch-open'), [0, 50, 100, 150, 200, 260, 400], { cols: 4, settle: 600 })
    await run('run-dock-out', dock, () => click('task-composer-close'), [0, 40, 80, 120, 160, 250], { cols: 3, settle: 400 })
    await press('escape'); await settleAll(400)
    await pick(); await settleAll(400)
    await run('kbd-run-dock', dock, () => press('cmd-enter'), [0, 100], { cols: 2, settle: 600 })
    await click('task-composer-close').catch(() => {}); await settleAll(400)
    await press('escape'); await settleAll(400)
    await a.mouse.wheel({ x: 700, y: 300 }, 0, -4000); await settleAll(300)
    // status glyph swap and count pop from another client changing a task's status
    await run('task-status-swap', { x: 308, y: 46, w: 972, h: 330 }, async () => { await client.call('tasks.items.update', { id: first, status: 'done' }) }, [0, 40, 80, 120, 170, 250, 400], { cols: 4, settle: 500 })
    await client.call('tasks.items.update', { id: first, status: 'todo' }); await settleAll(500)
    // sidebar: Projects chevron and the rows that fold away
    await run('tasks-projects-collapse', { x: 52, y: 200, w: 256, h: 360 }, () => click('task-projects-toggle'), [0, 15, 30, 50, 80, 120, 180, 300], { cols: 4, settle: 0, undo: () => click('task-projects-toggle') })
    await click('task-projects-toggle'); await settleAll(300)
    // task page opened by a click rises in; Enter shows it at once; the back arrow has no motion
    let open = second
    for (const n of await a.getByType('div').all()) if (n.testId?.startsWith('task-drag-') && n.bounds && n.bounds.y > 120 && n.bounds.y < 560) { open = n.testId.slice(10); break }
    await run('task-page-open', { x: 308, y: 46, w: 972, h: 500 }, () => click(`task-drag-${open}`), [0, 40, 80, 120, 160, 250], { cols: 3, settle: 500 })
    await rest()
    await click('task-back'); await settleAll(400)
    await run('kbd-task-page-open', { x: 308, y: 46, w: 972, h: 500 }, async () => { await focus(`task-row-${open}`); await a.getByTestId(`task-row-${open}`).press('enter') }, [0, 100], { cols: 2, settle: 500 })
    await press('escape'); await settleAll(400)
  })
  // ─── Pull requests ─────────────────────────────────────────────────────
  await step('Pulls', async () => {
    await page('pulls')
    await run('pr-filter-pill', { x: 52, y: 90, w: 360, h: 70 }, () => click('pr-filter-merged'), [0, 50, 100, 150, 200, 250, 400], { cols: 4, settle: 0, undo: () => click('pr-filter-open') })
    await click('pr-filter-open'); await settleAll(500)
    delays.set('github.pr.detail', 6000)
    await run('pr-skeleton', { x: 52, y: 46, w: 1228, h: 420 }, () => click('pr-row-109'), [0, 100, 150, 200, 300, 450], { cols: 3, settle: 300 })
    delays.delete('github.pr.detail'); await sleep(7000); await ff(900); await rest()
    await run('pr-detail-open', { x: 52, y: 46, w: 1228, h: 480 }, () => click('pr-row-108'), [0, 50, 100, 150, 250], { cols: 3, settle: 700 })
    await rest()
    await run('pr-tab-pill', { x: 300, y: 46, w: 400, h: 50 }, () => click('pr-tab-changes'), [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 0, undo: () => click('pr-tab-summary') })
    await run('pr-tab-changes', { x: 52, y: 46, w: 1228, h: 480 }, () => click('pr-tab-summary').then(() => sleep(400)).then(() => ff(800)).then(() => click('pr-tab-changes')), [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 700 })
    await run('pr-tab-timeline', { x: 52, y: 46, w: 1228, h: 480 }, () => click('pr-tab-timeline'), [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 700 })
    await click('pr-tab-summary'); await settleAll(500)
    await run('kbd-pr-tab', { x: 52, y: 46, w: 1228, h: 480 }, async () => { await focus('pr-tab-summary'); await a.getByTestId('pr-tab-summary').press('right') }, [0, 100], { cols: 2, settle: 600 })
    await click('pr-tab-summary'); await settleAll(500)
    await run('pr-copy-link', { x: 700, y: 46, w: 580, h: 50 }, () => click('pr-copy-link'), [0, 60, 125, 190, 250, 400], { cols: 3, settle: 300 })
    await ff(1700); await rest()
    await run('pr-copy-link-back', { x: 700, y: 46, w: 580, h: 50 }, async () => {}, [0, 60, 125, 190, 250, 400], { cols: 3, settle: 300 })
    // merge: the state pill swaps Open → Merged and pops, a check stands in for the merge button for 1.5 s
    await click('pr-merge'); await sleep(600); await ff(900)
    await run('pr-merged', { x: 52, y: 46, w: 1228, h: 260 }, () => click('pr-confirm-submit'), [0, 60, 125, 190, 250, 400, 700], { cols: 4, settle: 700 })
    await ff(1800); front.reset()
  })
  // ─── Usage ─────────────────────────────────────────────────────────────
  await step('Usage', async () => {
    await run('usage-enter', WIN, () => click('rail-usage'), [0, 100, 200, 300, 450, 700], { cols: 3, settle: 700 })
    await rest()
    await run('usage-period', { x: 52, y: 330, w: 1228, h: 420 }, async () => { await click('usage-period'); await sleep(300); await ff(400); await click('usage-period-7') }, [0, 60, 125, 190, 250, 400], { cols: 3, settle: 600 })
    await run('usage-group', { x: 52, y: 380, w: 1228, h: 440 }, () => click('usage-group-model'), [0, 40, 80, 125, 170, 250, 400], { cols: 4, settle: 600 })
    await run('usage-group-pill', { x: 300, y: 70, w: 700, h: 70 }, () => click('usage-group-day'), [0, 50, 100, 150, 200, 250, 400], { cols: 4, settle: 0 })
  })
  // ─── Settings ──────────────────────────────────────────────────────────
  await step('Settings', async () => {
    await run('settings-open', { x: 0, y: 46, w: 1280, h: 560 }, () => click('rail-settings'), [0, 300, 450], { cols: 3, settle: 500 })
    await ff(800)
    await run('settings-tab', { x: 0, y: 46, w: 1280, h: 560 }, () => click('settings-tab-appearance'), [0, 40, 80, 120, 170, 250, 400], { cols: 4, settle: 400, undo: () => click('settings-tab-general') })
    await click('settings-tab-general'); await settleAll(400)
    await run('kbd-settings-tab', { x: 0, y: 46, w: 1280, h: 560 }, async () => { await focus('settings-tab-appearance'); await a.getByTestId('settings-tab-appearance').press('enter') }, [0, 100], { cols: 2, settle: 400 })
    await click('settings-tab-general'); await settleAll(400)
    await run('settings-select', { x: 700, y: 120, w: 580, h: 300 }, () => click('settings-default-agent'), [0, 60, 125, 190, 250, 400], { cols: 3, settle: 400 })
    await press('escape'); await settleAll(300)
    await run('settings-tab-pill', { x: 0, y: 150, w: 300, h: 300 }, () => click('settings-tab-notifications'), [0, 60, 125, 190, 250, 400], { cols: 3, settle: 400 })
    await click('settings-tab-background'); await settleAll(500)
    await click('settings-back'); await settleAll(500)
  })
}

for (const theme of themes) for (const reduced of reduceds) await session(theme, reduced)
process.exit(0)
