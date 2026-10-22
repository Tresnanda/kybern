/**
 * ADE-54 tabs vs today's dock, same scratch daemon and workload (`perf/tabs-ade54-2026-10-23.md`).
 *
 *   bun perf/tabs-ade54.ts tabs  [runs]   # this checkout: in-thread tabs
 *   bun perf/tabs-ade54.ts dock  [runs]   # BASE_CHECKOUT (main @ v0.11.1): the file viewer in the dock
 *
 * Needs the scratch daemon of `src/tabs/verify.ts` (run it once). Scratch only: never ~/.kybern, never port 4219.
 * Each run: (1) switching, 30 alternations between the long thread's chat and a document (tabs: ⌘2/⌘1; dock: the
 * Explorer and Changes panes beside the chat), one every 350 ms; (2) a 2×2 split on the long thread, 15 s idle, then
 * 20 ⌃Tab presses (tabs) or 20 dock pane switches (dock). Footprint (`footprint`), CPU time (`ps`), frame intervals
 * (`KYBERN_FRAME_TIMES`) and the key-to-content latency seen by automation.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

process.env.VISUAL_SCRATCH ??= '/Users/mymac/projects/ade-gpuix-scratch/tabs-ade54'
const fixture = await import('../visual/fixture.ts')
const { launchFixture } = await import('../src/requests/harness.ts')
const mode = process.argv[2] === 'dock' ? 'dock' : 'tabs'
const runs = Number(process.argv[3] ?? 3)
const BASE = process.env.BASE_CHECKOUT ?? '/Users/mymac/projects/ade-gpuix-scratch/tabs-ade54-base'
const entry = mode === 'dock' ? path.join(BASE, 'apps/gpuix/src/main.tsx') : path.join(import.meta.dir, '../src/main.tsx')

const state = fixture.readState()
if (!state) throw Error('No scratch daemon: run bun src/tabs/verify.ts once')
const client = await fixture.connect(state)
const { threads } = await client.call('threads.list', {})
const long = threads.find((t) => t.title === 'Long review thread')!
const other = threads.find((t) => t.title === 'Date helper cleanup')!
const third = threads.find((t) => t.title === 'Rich reply')!
const fourth = threads.find((t) => t.title === 'Short exchange')!

const footprint = (pid: number) => { const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' }); const m = out.match(/phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/) ?? out.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); return m ? Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1) : NaN }
const cpu = (pid: number) => execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(':').map(Number).reduce((a, v) => a * 60 + v, 0)
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN }
const intervals = (stamps: number[]) => stamps.slice(1).map((t, i) => t - stamps[i]!)
/** Frame intervals inside bursts: gaps over 250 ms are the idle time between two switches, not a slow frame. */
const busy = (gaps: number[]) => gaps.filter((g) => g < 250)
const leaf = (id: string, threadId: string) => ({ kind: 'leaf', id, threadId })
const file = (p: string) => ({ kind: 'file', path: p, root: 'project' })

function layout(kind: 'switch' | 'split') {
  if (mode === 'tabs') {
    const groups = kind === 'switch'
      ? { main: { threadId: long.id, tabs: [{ kind: 'chat' }, file('src/Explorer.tsx'), { kind: 'diff' }], active: 'chat', preview: null } }
      : {
        a: { threadId: long.id, tabs: [{ kind: 'chat' }], active: 'chat', preview: null }, b: { threadId: long.id, tabs: [file('src/Explorer.tsx'), file('src/theme.ts')], active: 'file:project:src/Explorer.tsx', preview: null },
        c: { threadId: long.id, tabs: [{ kind: 'diff' }, file('docs/notes.md')], active: 'diff:*', preview: null }, d: { threadId: other.id, tabs: [{ kind: 'chat' }], active: 'chat', preview: null },
      }
    const root = kind === 'switch' ? leaf('main', long.id) : { kind: 'split', id: 's1', direction: 'horizontal', ratio: 0.5, first: { kind: 'split', id: 's2', direction: 'vertical', ratio: 0.5, first: leaf('a', long.id), second: leaf('c', long.id) }, second: { kind: 'split', id: 's3', direction: 'vertical', ratio: 0.5, first: leaf('b', long.id), second: leaf('d', other.id) } }
    return { 'kybern.split-view.v2': { version: 2, root, focusedPaneId: kind === 'switch' ? 'main' : 'b', groups }, 'kybern.tabs.threads': [] }
  }
  // Today: the document is read in the dock beside the chat; a 2×2 holds four threads.
  const dock = [[long.id, { open: true, tabs: ['explorer', 'changes'], tab: 'explorer', width: 520 }]]
  const root = kind === 'switch' ? leaf('main', long.id) : { kind: 'split', id: 's1', direction: 'horizontal', ratio: 0.5, first: { kind: 'split', id: 's2', direction: 'vertical', ratio: 0.5, first: leaf('a', long.id), second: leaf('c', third.id) }, second: { kind: 'split', id: 's3', direction: 'vertical', ratio: 0.5, first: leaf('b', fourth.id), second: leaf('d', other.id) } }
  return { 'kybern.split-view.v1': { version: 1, root, focusedPaneId: kind === 'switch' ? 'main' : 'a' }, 'kybern.dock.choices': dock }
}

async function launch(kind: 'switch' | 'split') {
  writeFileSync(path.join(fixture.DATA_DIR, 'gpuix-ui.json'), JSON.stringify(layout(kind)))
  const f = await launchFixture(entry, {
    GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: 'dark', KYBERN_REDUCED_MOTION: '0', KYBERN_FRAME_TIMES: '1', KYBERN_WINDOW_SIZE: '1440x900',
    KYBERN_DATA_DIR: fixture.DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: fixture.CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: fixture.CREDS_DIR, KYBERN_URL: '', KYBERN_TOKEN: '',
  })
  await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await Bun.sleep(6000)
  return f
}

type Row = Record<string, number | string>
const rows: Row[] = []
for (let run = 1; run <= runs; run++) {
  // (1) Switching between the chat and a document.
  {
    const f = await launch('switch')
    const app = f.app, root = app.getByTestId('app-ready')
    if (mode === 'dock') { await app.getByTestId('dock-file-src').click(); await Bun.sleep(500); await app.getByTestId('dock-file-src/Explorer.tsx').click(); await Bun.sleep(1500) }
    const mem0 = footprint(f.pid), cpu0 = cpu(f.pid), frames0 = f.frameTimes().length
    const latency: number[] = []
    for (let i = 0; i < Number(process.env.SWITCHES ?? 30); i++) {
      const started = performance.now()
      if (mode === 'tabs') {
        await root.press(i % 2 === 0 ? 'cmd-2' : 'cmd-1')
        const target = i % 2 === 0 ? 'tab-body-file:project:src/Explorer.tsx' : 'transcript-surface'
        for (let n = 0; n < 200 && !(await app.getByTestId(target).count()); n++) await Bun.sleep(5)
      } else {
        await app.getByTestId(i % 2 === 0 ? 'dock-tab-changes' : 'dock-tab-explorer').click()
        const target = i % 2 === 0 ? 'dock-commit' : 'dock-file-tree'
        for (let n = 0; n < 200 && !(await app.getByTestId(target).count()); n++) await Bun.sleep(5)
      }
      latency.push(performance.now() - started)
      await Bun.sleep(Math.max(0, 350 - (performance.now() - started)))
    }
    const stamps = f.frameTimes().slice(frames0)
    const gaps = intervals(stamps)
    rows.push({ mode, run, test: 'switch', cpuS: +(cpu(f.pid) - cpu0).toFixed(2), memStartMB: +mem0.toFixed(0), memEndMB: +footprint(f.pid).toFixed(0), frames: stamps.length, frameP50: +pct(busy(gaps), 0.5).toFixed(1), frameP95: +pct(busy(gaps), 0.95).toFixed(1), frameMax: +Math.max(0, ...busy(gaps)).toFixed(1), latencyP50: +pct(latency, 0.5).toFixed(0), latencyP95: +pct(latency, 0.95).toFixed(0) })
    await f.close()
  }
  // (2) A 2×2 on the long thread: idle, then switching inside the focused group.
  {
    const f = await launch('split')
    const app = f.app, root = app.getByTestId('app-ready')
    const mem0 = footprint(f.pid), cpu0 = cpu(f.pid), frames0 = f.frameTimes().length
    await Bun.sleep(15_000)
    const idleCpu = cpu(f.pid) - cpu0, idleFrames = f.frameTimes().length - frames0
    const cpu1 = cpu(f.pid), frames1 = f.frameTimes().length
    for (let i = 0; i < 20; i++) {
      if (mode === 'tabs') await root.press('ctrl-tab')
      else await app.getByTestId(i % 2 === 0 ? 'dock-tab-changes' : 'dock-tab-explorer').click().catch(() => {})
      await Bun.sleep(350)
    }
    const gaps = intervals(f.frameTimes().slice(frames1))
    rows.push({ mode, run, test: 'split2x2', idleCpuS: +idleCpu.toFixed(2), idleFrames, memMB: +mem0.toFixed(0), memAfterMB: +footprint(f.pid).toFixed(0), switchCpuS: +(cpu(f.pid) - cpu1).toFixed(2), switchFrames: gaps.length + 1, frameP50: +pct(busy(gaps), 0.5).toFixed(1), frameP95: +pct(busy(gaps), 0.95).toFixed(1), frameMax: +Math.max(0, ...busy(gaps)).toFixed(1) })
    await f.close()
  }
  console.log(JSON.stringify(rows.slice(-2)))
}
const out = path.join(import.meta.dir, `tabs-ade54-${mode}.json`)
writeFileSync(out, JSON.stringify(rows, null, 1))
client.close?.()
console.log(`[perf] ${rows.length} rows → ${out}`)
process.exit(0)
