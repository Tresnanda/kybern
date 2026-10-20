// P1 motion strips (V-strip + V-cost + V-rm + V-kbd evidence). Two targets, each under a paused automation clock stepped to every
// offset, one window screenshot per frame (visual strips only: never a timing run):
//   lab  scripts/motion-p1-lab.tsx: the sidebar status glyph, title swap and hover-actions crossfade (needs a live turn in the app).
//   app  the real app against the P1 scratch daemon (+ the settings visual proxy for plan usage): sidebar, rail, title bar, settings, home.
//   bun native/ui-lease.ts gpuix-p1 bun scripts/motion-p1-strips.ts [--target lab|app|both] [--theme dark|light|both] [--reduced 0|1|both] [--only a,b]
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
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const target = arg('--target', 'both')
const only = process.argv.includes('--only') ? new Set(arg('--only', '').split(',')) : null
const root = arg('--out', '/Users/mymac/projects/ade/previews/motion/gpuix-p1')
const SCRATCH = '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p1'
const scratch = { KYBERN_DATA_DIR: `${SCRATCH}/data`, KYBERN_CLIENT_CONFIG_DIR: `${SCRATCH}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${SCRATCH}/credentials`, KYBERN_ENVIRONMENT_NAME: 'Development environment' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Crop = { x: number; y: number; w: number; h: number }
type App = Awaited<ReturnType<typeof launchFixture>>['app']

type StripSet = { name: string; strip: string; frames: string[]; counts: number[]; cost?: string }
/** Runs one launch of `entry` and lets `scenes` drive it; returns the strips to write. */
async function session(label: string, dir: string, entry: string, env: Record<string, string>, crops: Record<string, Crop>, scenes: (ctx: Ctx) => Promise<void>, scale: number) {
  mkdirSync(dir, { recursive: true })
  const f = await launchFixture(path.join(import.meta.dir, '..', entry), { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_DEBUG_ISLANDS: '1', ...env })
  const sets: StripSet[] = []
  try {
    const a = f.app
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    const ctx: Ctx = {
      a, f, sleep,
      shot: async name => { await sleep(30); const file = path.join(dir, `${name}.png`); await a.screenshot({ path: file }); return file },
      run: async (id, trigger, offsets, strips, settle = 700, undo) => {
        if (only && !only.has(id.replace(/-\d+$/, '')) && !only.has(id)) { await trigger(); await a.clock.fastForward(settle); return }
        await trigger()
        const frames: string[] = [], seen: number[] = []
        let at = 0
        for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; frames.push(await ctx.shot(`${id}-${String(o).padStart(3, '0')}`)); seen.push(f.islandRenders()) }
        await a.clock.fastForward(settle)
        // V-cost: the same tween again with no screenshots (a screenshot itself renders the islands): React renders the tween adds after its trigger settled.
        let cost: string | undefined
        if (undo) {
          await undo(); await a.clock.fastForward(700); await sleep(120)
          await trigger(); await sleep(150)
          const before = f.islandRenders(), total = Math.max(...offsets)
          for (let i = 0; i < 4; i++) await a.clock.fastForward(total / 4)
          await sleep(60)
          cost = `${f.islandRenders() - before} island renders over a ${total} ms tween (no screenshots)`
          await a.clock.fastForward(settle)
        }
        for (const s of strips) sets.push({ name: id, strip: s, frames, counts: seen, cost })
      },
    }
    await scenes(ctx)
  } finally { await f.close() }
  const lines: string[] = []
  for (const s of sets) {
    const raw = crops[s.strip]
    if (!raw) { lines.push(`${s.name} (${s.strip}): no crop`); continue }
    // Window-sized frames: keep a crop inside them (the lab window is 360x240, the app 1280x820).
    const [ww, wh] = entry.includes('motion-p1-lab') ? [360, 240] : [1280, 820]
    const c = { x: Math.round(raw.x), y: Math.round(raw.y), w: Math.round(Math.min(raw.w, ww)), h: Math.round(Math.min(raw.h, wh)) }
    c.x = Math.max(0, Math.min(c.x, ww - c.w)); c.y = Math.max(0, Math.min(c.y, wh - c.h))
    const out = path.join(dir, `${s.name}--${s.strip}-strip.png`)
    const cols = Math.min(s.frames.length, c.w * scale > 400 ? 4 : 8)
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(c.x * scale), String(c.y * scale), String(c.w * scale), String(c.h * scale), String(cols), ...s.frames.flatMap(file => ['top:0', file])])
    // Small crops (a glyph, a row edge) are enlarged so the strip reads at a glance.
    const width = c.w * scale * cols + 8 * (cols - 1)
    if (width < 1000) execFileSync('sips', ['--resampleWidth', String(Math.round(width * Math.min(4, 1400 / width))), out], { stdio: 'ignore' })
    lines.push(`${s.name} (${s.strip}): ${s.cost ?? 'cost not measured (no inverse)'}; island renders per screenshot frame ${s.counts.join('/')}`)
  }
  writeFileSync(path.join(dir, 'README.txt'), `GPUIX motion P1 ${label}.\n${lines.join('\n')}\n`)
  console.log(`ok ${label}\n  ${lines.join('\n  ')}`)
}
type Ctx = {
  a: App
  f: Awaited<ReturnType<typeof launchFixture>>
  sleep: (ms: number) => Promise<unknown>
  shot: (name: string) => Promise<string>
  run: (id: string, trigger: () => Promise<void>, offsets: number[], strips: string[], settle?: number, undo?: () => Promise<void>) => Promise<void>
}

const T = [0, 40, 80, 120, 160, 250, 400]

// ─── lab ──────────────────────────────────────────────────────────────────
const LAB_CROPS: Record<string, Crop> = {
  glyph: { x: 24, y: 24, w: 40, h: 40 }, row: { x: 16, y: 84, w: 272, h: 40 }, title: { x: 24, y: 90, w: 200, h: 28 }, edge: { x: 216, y: 84, w: 72, h: 40 },
}
async function lab(theme: string, reduced: string, dir: string) {
  await session(`lab ${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir, 'scripts/motion-p1-lab.tsx', { KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced }, LAB_CROPS, async ({ a, run, sleep }) => {
    await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
    const key = async (k: string) => { await a.call('keyDown', { key: k }) }
    await sleep(600)
    await a.clock.pause()
    // working → unread → failed → none → pending → pinned → working (each step cross-swaps; dots that appear pop)
    for (const [i, name] of ['working-unread', 'unread-failed', 'failed-none', 'none-pending', 'pending-pinned', 'pinned-working'].entries()) await run(`glyph-${i + 1}-${name}`, () => key('g'), [0, 40, 80, 125, 170, 250, 400], ['glyph'])
    await run('title-swap', () => key('t'), [0, 40, 80, 125, 170, 250, 400], ['title'])
    await run('title-swap-back', () => key('t'), [0, 40, 80, 125, 170, 250, 400], ['title'])
    // The row's hover: actions in (150 ms, 4 px) and out (100 ms) while the resting glyph fades back over them.
    await run('reveal-in', () => key('h'), [0, 30, 60, 100, 150, 250], ['edge'])
    await run('reveal-out', () => key('h'), [0, 30, 60, 100, 150, 250], ['edge'])
    await a.clock.resume()
  }, 2)
}

// ─── app ──────────────────────────────────────────────────────────────────
const APP_CROPS: Record<string, Crop> = {
  // 1280x820 window: title bar 46, rail 52, thread panel to x = 308 (rail + 256)
  drawer: { x: 0, y: 0, w: 640, h: 300 }, rail: { x: 0, y: 46, w: 52, h: 260 }, settings: { x: 52, y: 46, w: 560, h: 300 }, home: { x: 380, y: 300, w: 660, h: 260 },
  navbtns: { x: 80, y: 0, w: 200, h: 46 }, titles: { x: 300, y: 0, w: 420, h: 46 },
}
type Sessionish = { provider: string; id: string; title: string; cwd: string; updated_at: string; thread_id?: string | null }
/** A WebSocket front for the app: serves a fixed saved-session list (a second `sessions.list` also returns two new ones) and can hold a method forever (so the loader shows). */
function interceptor(upstream: string, hold: Set<string>) {
  let lists = 0
  const iso = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  const base = (provider: string): Sessionish[] => ['Refactor the date helpers', 'Fix flaky sidebar test', 'Draft release notes', 'Investigate slow thread load', 'Review the rail design', 'Port the usage popover'].map((title, i) => ({ provider, id: `${provider}-${i}`, title, cwd: '/fixture/projects/app', updated_at: iso(10 + i * 40), thread_id: null }))
  const server = Bun.serve<{ up: WebSocket; queued: string[] }>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, srv) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') { const target = new URL(req.url); target.port = new URL(upstream).port; return fetch(new Request(target, req)) }
      const up = new WebSocket(upstream, { headers: { origin: 'tauri://localhost' } } as never)
      if (srv.upgrade(req, { data: { up, queued: [] } })) return
      up.close(); return new Response('no', { status: 404 })
    },
    websocket: {
      open(ws) {
        ws.data.up.onmessage = e => ws.send(String(e.data))
        ws.data.up.onopen = () => { for (const m of ws.data.queued) ws.data.up.send(m); ws.data.queued = [] }
        ws.data.up.onclose = () => ws.close()
      },
      message(ws, raw) {
        const text = String(raw), req = JSON.parse(text)
        const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
        if (hold.has(req.method)) { return }
        if (req.method === 'sessions.list') {
          const n = ++lists, sessions = base(req.params.provider)
          if (n > 3) sessions.unshift(...['Check the new connection banner', 'Tune the update card'].map((title, i) => ({ provider: req.params.provider, id: `${req.params.provider}-new-${i}`, title, cwd: '/fixture/projects/app', updated_at: iso(1 + i), thread_id: null })))
          reply({ sessions: req.params.provider === 'codex' || req.params.provider === 'claude-code' ? sessions : [], next_cursor: null })
          return
        }
        if (ws.data.up.readyState === WebSocket.OPEN) ws.data.up.send(text)
        else ws.data.queued.push(text)
      },
      close(ws) { ws.data.up.close() },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}/ws`, stop: () => server.stop(true) }
}
async function app(theme: string, reduced: string, dir: string) {
  const state = readState()
  if (!state) throw new Error('no P1 scratch daemon (VISUAL_SCRATCH=…/motion-gpuix-p1 VISUAL_DAEMON_PORT=4365 bun visual/up.ts)')
  const client = await connect(state)
  await startSettingsProxy(client) // starts the mocking proxy (plan usage, providers) and sets KYBERN_URL / KYBERN_TOKEN
  const proxyPort = readState()!.port
  const projects = (await client.call('projects.list', {})).projects, threads = (await client.call('threads.list', {})).threads
  await fetch(`http://127.0.0.1:${proxyPort}/mode?value=s9-rich`)
  const hold = new Set<string>()
  const front = interceptor(`ws://127.0.0.1:${proxyPort}/ws`, hold)
  const project = projects.find(p => p.name === 'kybern-app')!
  const threadOf = (title: string) => threads.find(th => th.title.startsWith(title))!.id
  await client.call('threads.update', { thread_id: threadOf('Visual reply'), title: 'Visual reply' }) // an earlier run renamed it
  const env = { ...scratch, KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_URL: front.url, KYBERN_TOKEN: process.env.KYBERN_TOKEN!, KYBERN_WINDOW_SIZE: '1280x820' }
  const crops = { ...APP_CROPS }
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`
  try {
    // Launch 1: plan-usage rings drawing in as their first value arrives (the clock is paused before the answer lands).
    await session(`app startup ${label}`, path.join(dir, 'startup'), 'src/main.tsx', env, crops, async ({ a, run, sleep }) => {
      await a.clock.pause()
      const ring = await (async () => { for (let i = 0; i < 80; i++) { try { return await a.getByTestId('rail-usage-codex').center() } catch { await sleep(250) } } throw new Error('no usage ring') })()
      crops.ring = { x: 0, y: ring.y - 24, w: 52, h: 130 }
      await run('rings-draw', async () => {}, [0, 100, 200, 300, 400, 500], ['ring'])
      // An unchanged refresh (hovering a ring re-reads it) must not redraw the arc; the card opens beside it.
      crops.card = { x: 0, y: ring.y - 300, w: 420, h: 420 }
      await run('rings-refresh-card', async () => { await a.mouse.move(ring) }, [0, 100, 200, 300, 400, 600], ['card', 'ring'])
      await a.clock.resume()
    }, 2)
    // Launch 2: everything that needs a settled workspace.
    await session(`app ${label}`, dir, 'src/main.tsx', env, crops, async ({ a, run, sleep }) => {
      const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c) }
      const park = { x: 1275, y: 815 }
      const press = (k: string) => a.getByTestId('app-ready').press(k)
      await sleep(2500)
      await a.getByTestId('rail-home').click(); await sleep(800)
      await a.mouse.move(park); await sleep(300)
      await a.clock.pause()
      const ff = (ms: number) => a.clock.fastForward(ms)
      // thread row hover: actions in (150 ms, 4 px) and out (100 ms) with the resting glyph fading back over them
      const row = await a.getByTestId(`thread-${threadOf('Rounded clip review')}`).center()
      crops.row = { x: 52, y: row.y - 22, w: 256, h: 44 }; crops.edge = { x: 236, y: row.y - 22, w: 72, h: 44 }
      await run('row-hover-in', async () => { await a.mouse.move(row) }, [0, 30, 60, 100, 150, 250], ['row', 'edge'], 700, async () => { await a.mouse.move(park) })
      await run('row-hover-out', async () => { await a.mouse.move(park) }, [0, 30, 60, 100, 150, 250], ['row', 'edge'], 700, async () => { await a.mouse.move(row) })
      // press-row: a held row darkens (light) / lightens (dark); the fill is instant
      const resume = await a.getByTestId('resume-session').center()
      crops.press = { x: 52, y: resume.y - 60, w: 256, h: 100 }
      await run('press-row', async () => { await a.mouse.move(resume); await ff(200); await a.mouse.down(resume) }, [0, 100], ['press'])
      await a.mouse.up(resume).catch(() => {}); await a.mouse.move(park); await ff(400)
      // disclosure chevron: hover a project header, click its toggle
      const header = await a.getByTestId(`project-${project.id}`).center()
      crops.project = { x: 52, y: header.y - 20, w: 256, h: 230 }
      await a.mouse.move(header); await ff(400)
      await run('chevron-collapse', () => click(`project-toggle-${project.id}`), [0, 55, 110, 165, 220, 300], ['project'], 700, () => click(`project-toggle-${project.id}`))
      await run('chevron-expand', () => click(`project-toggle-${project.id}`), [0, 55, 110, 165, 220, 300], ['project'], 700, () => click(`project-toggle-${project.id}`))
      await a.mouse.move(park); await ff(400)
      // sidebar drawer + surface enter: closing 200 ms, opening 260 ms on the drawer curve; ⌘B is instant
      await run('drawer-close', () => click('sidebar-toggle'), [0, 50, 100, 150, 200, 300], ['drawer'], 700, () => click('sidebar-toggle'))
      await run('drawer-open', () => click('sidebar-toggle'), [0, 65, 130, 195, 260, 400], ['drawer'], 700, () => click('sidebar-toggle'))
      await run('kbd-drawer-close', () => press('cmd-b'), [0, 100], ['drawer'])
      await run('kbd-drawer-open', () => press('cmd-b'), [0, 100], ['drawer'])
      await a.mouse.move(park); await ff(400)
      // rail pill: Home → Tasks → Home by click, then ⌘[ (back) jumps
      await run('rail-pill', () => click('rail-tasks'), [0, 60, 125, 190, 250, 400], ['rail'], 700, () => click('rail-home'))
      await run('rail-pill-back', () => click('rail-home'), [0, 60, 125, 190, 250, 400], ['rail'], 700, () => click('rail-tasks'))
      await click('rail-tasks'); await ff(600)
      await run('kbd-rail-pill', () => press('cmd-['), [0, 100], ['rail'])
      // settings as a layer: pointer open / close, then ⌘, and Escape
      await run('settings-open', () => click('rail-settings'), [0, 40, 80, 120, 160, 250, 400], ['settings'], 700, () => click('settings-back'))
      await run('settings-close', () => click('settings-back'), [0, 40, 80, 120, 160, 250, 400], ['settings'], 700, () => click('rail-settings'))
      await run('kbd-settings-open', () => press('cmd-,'), [0, 100], ['settings'])
      await run('kbd-settings-close', () => press('escape'), [0, 100], ['settings'])
      // back / forward dim and the header + sidebar title swap on a rename
      const opened = threadOf('Visual reply')
      await run('nav-dim', () => click(`thread-${opened}`), [0, 40, 80, 150, 250], ['navbtns'], 900)
      const at = await a.getByTestId(`thread-${opened}`).center()
      crops.rename = { x: 52, y: Math.min(at.y - 22, 600), w: 256, h: 44 }
      await client.call('threads.update', { thread_id: opened, title: 'Visual reply with renamed title' })
      await run('rename-swap', async () => {}, [0, 40, 80, 125, 170, 250, 400], ['titles', 'rename'])
      // home heading stagger after a pointer "New chat"
      await run('home-stagger', () => click('new-chat'), [0, 70, 140, 210, 300, 500], ['home'], 900)
      // resume-session dialog: the opening state of its button
      await click('resume-session'); await ff(800)
      await a.mouse.move(park); await ff(300)
      hold.add('sessions.resume')
      const first = await a.getByTestId('sessions-resume').center()
      crops.resume = { x: first.x - 280, y: first.y - 40, w: 560, h: 80 }
      await run('sessions-opening', () => click('session-0'), [0, 60, 125, 190, 250, 400], ['resume'])
      void first
      await a.clock.resume()
    }, 2)
  } finally { front.stop(); client.close?.() }
}

// ─── extra: items that need their own launch (update fixture, connection banner, environment dialog, split panes, menus) ───────────
const EXTRA_CROPS: Record<string, Crop> = {
  announce: { x: 880, y: 400, w: 400, h: 420 }, banner: { x: 360, y: 46, w: 560, h: 120 }, envdlg: { x: 380, y: 130, w: 520, h: 120 },
  advanced: { x: 380, y: 360, w: 520, h: 80 }, split: { x: 308, y: 46, w: 964, h: 120 }, menu: { x: 60, y: 40, w: 300, h: 300 },
}
async function extra(theme: string, reduced: string, dir: string) {
  const state = readState()!
  const client = await connect(state)
  await startSettingsProxy(client)
  const proxyPort = readState()!.port
  const threads = (await client.call('threads.list', {})).threads
  await fetch(`http://127.0.0.1:${proxyPort}/mode?value=s9-rich`)
  const hold = new Set<string>(['threads.create'])
  const front = interceptor(`ws://127.0.0.1:${proxyPort}/ws`, hold)
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`
  const env = { ...scratch, KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_URL: front.url, KYBERN_TOKEN: process.env.KYBERN_TOKEN!, KYBERN_WINDOW_SIZE: '1280x820' }
  const crops = { ...EXTRA_CROPS }
  const waitFor = async (a: App, id: string) => { for (let i = 0; i < 120; i++) { try { return await a.getByTestId(id).center() } catch { await sleep(250) } } throw new Error(`no ${id}`) }
  try {
    // The announcement is shown once per version and the dismissal is remembered: start from a clean client dir.
    rmSync(`${SCRATCH}/client`, { recursive: true, force: true })
    writeFileSync(`${SCRATCH}/data/gpuix-ui.json`, '{}') // the last page and layout are remembered: start on Home
    // P1.14: the update announcement enters (scale 0.97, 2 px blur, 16 px) and leaves (dismiss).
    await session(`extra update ${label}`, path.join(dir, 'update'), 'src/platform/update.fixture.ts', env, crops, async ({ a, run, sleep }) => {
      await a.clock.pause()
      await waitFor(a, 'update-announcement')
      await run('announcement-enter', async () => {}, [0, 60, 125, 190, 250, 350, 500], ['announce'])
      await run('announcement-exit', async () => { const c = await a.getByTestId('update-announcement-dismiss').center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c) }, [0, 50, 100, 150, 200, 260], ['announce'])
      await a.clock.resume()
    }, 2)
    // P1.21: the connection banner enters and leaves (a failed banner's Reconnect makes the status leave `failed`).
    await session(`extra banner ${label}`, path.join(dir, 'banner'), 'src/main.tsx', { ...env, KYBERN_PREVIEW: 'banner-failed' }, crops, async ({ a, run, sleep }) => {
      await sleep(1000); await a.clock.pause()
      await waitFor(a, 'connection-banner'); await waitFor(a, 'connection-reconnect')
      await run('banner-enter', async () => {}, [0, 40, 80, 120, 160, 250], ['banner'])
      await run('banner-exit', async () => { const c = await a.getByTestId('connection-reconnect').center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c) }, [0, 30, 60, 90, 120, 200], ['banner'])
      await a.clock.resume()
    }, 2)
    // P1.19 / P1.20 / P1.16-adjacent: the environment dialog's tab pill and Advanced disclosure; P1.6: Reload agents icon swap.
    await session(`extra dialogs ${label}`, path.join(dir, 'dialogs'), 'src/main.tsx', env, crops, async ({ a, run, sleep }) => {
      const click = async (id: string) => { const c = await waitFor(a, id); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c) }
      const press = (k: string) => a.getByTestId('app-ready').press(k)
      await sleep(2500); await a.mouse.move({ x: 1275, y: 815 }); await sleep(300)
      // Reload agents: open the kybern menu, walk to the item (Add project, Settings, Commands, Reload) and select it
      const menu = await waitFor(a, 'app-menu')
      crops.menuicon = { x: menu.x - 60, y: menu.y - 20, w: 300, h: 260 }
      await click('app-menu'); await sleep(900)
      await a.clock.pause()
      for (let i = 0; i < 4; i++) await press('down')
      await run('reload-agents', () => press('enter'), [0, 60, 125, 190, 250, 400], ['menuicon'], 1200)
      await a.clock.resume(); await press('escape'); await sleep(600)
      // The environment dialog: SSH ↔ address tab pill and the Advanced triangle
      mkdirSync(`${SCRATCH}/client`, { recursive: true })
      writeFileSync(`${SCRATCH}/client/environments.json`, JSON.stringify({ selected_id: 'local', environments: [] }))
      await click('environment-switcher'); await sleep(500); await click('environment-add'); await waitFor(a, 'environment-machine')
      await a.mouse.move({ x: 1275, y: 815 }); await sleep(300)
      const adv = await waitFor(a, 'environment-advanced'), tab = await waitFor(a, 'environment-tab-address')
      crops.advanced = { x: adv.x - 90, y: adv.y - 40, w: 320, h: 110 }; crops.envdlg = { x: tab.x - 300, y: tab.y - 50, w: 600, h: 100 }
      await a.clock.pause()
      await run('env-advanced-open', () => click('environment-advanced'), [0, 55, 110, 165, 220, 300], ['advanced'])
      await run('env-advanced-close', () => click('environment-advanced'), [0, 55, 110, 165, 220, 300], ['advanced'])
      await run('env-tab-address', () => click('environment-tab-address'), [0, 60, 125, 190, 250, 400], ['envdlg'])
      await a.clock.resume()
    }, 2)
    // P1.10: a held row of the plan-usage card is filled; P1.17: rows that arrive after the dialog is open (a refresh) rise in.
    await session(`extra usage+sessions ${label}`, path.join(dir, 'usage-sessions'), 'src/main.tsx', env, crops, async ({ a, run, sleep }) => {
      const click = async (id: string) => { const c = await waitFor(a, id); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c) }
      await sleep(2500)
      const ring = await waitFor(a, 'rail-usage-codex')
      await a.mouse.move(ring); await sleep(1500)
      const details = await waitFor(a, 'usage-card-details')
      crops.usagecard = { x: details.x - 200, y: details.y - 24, w: 420, h: 48 }
      await a.clock.pause()
      await run('usage-row-press', async () => { await a.mouse.move(details); await a.mouse.down(details) }, [0, 100], ['usagecard'])
      // release outside the row: releasing on it would click through to the Usage page
      await a.mouse.move({ x: 1275, y: 815 }); await a.mouse.up({ x: 1275, y: 815 }).catch(() => {}); await a.clock.resume(); await sleep(600)
      await click('resume-session'); await sleep(2000)
      const first = await waitFor(a, 'session-0')
      crops.rows = { x: first.x - 340, y: first.y - 30, w: 680, h: 230 }
      await a.clock.pause()
      await run('sessions-refresh-rows', () => click('sessions-refresh'), [0, 60, 125, 190, 250, 400], ['rows'], 900)
      await a.clock.resume()
    }, 2)
    // P1.18: the focused split pane's ring fades between panes (pointer), and moves at once from the keyboard.
    await session(`extra split ${label}`, path.join(dir, 'split'), 'src/main.tsx', env, crops, async ({ a, run, sleep }) => {
      const press = (k: string) => a.getByTestId('app-ready').press(k)
      await sleep(2500)
      const row = await waitFor(a, `thread-${threads.find(th => th.title.startsWith('Visual reply'))!.id}`)
      await a.mouse.move(row); await a.mouse.down(row); await a.mouse.up(row); await sleep(1500)
      await press('cmd-\\'); await sleep(1500)
      const left = { x: 520, y: 70 }, right = { x: 1050, y: 70 } // the panes' headers: a transcript consumes the press
      await a.mouse.move(left); await a.mouse.down(left); await a.mouse.up(left); await sleep(400)
      await a.clock.pause()
      await run('split-ring-right', async () => { await a.mouse.move(right); await a.mouse.down(right); await a.mouse.up(right) }, [0, 30, 60, 90, 120, 200], ['split'])
      await run('split-ring-left', async () => { await a.mouse.move(left); await a.mouse.down(left); await a.mouse.up(left) }, [0, 30, 60, 90, 120, 200], ['split'])
      await a.clock.resume()
    }, 2)
  } finally { front.stop(); client.close?.() }
}

for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`
  if (target === 'lab' || target === 'both') await lab(theme, reduced, path.join(root, 'lab', label))
  if (target === 'app' || target === 'both') await app(theme, reduced, path.join(root, 'app', label))
  if (target === 'extra') await extra(theme, reduced, path.join(root, 'extra', label))
}
process.exit(0)
