/**
 * Side-by-side visual check: the Tauri desktop UI (WebKit) vs the GPUIX app.
 *
 *   bun scripts/visual-pair.ts [screen ...] [--theme dark|light|both] [--out dir] [--fresh] [--keep] [--gpuix-only] [--down]
 *
 * Starts a scratch daemon (data under ade-gpuix-scratch/visual-pair) and the
 * desktop Vite server, seeds fixtures over RPC, captures both UIs at 1280x820
 * and writes <screen>-<theme>-{tauri,gpuix,pair,diff}.png. `--down` stops
 * everything; without `--keep` the servers are stopped after the run.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { DATA_DIR, connect, readState, seed, startDaemon, stopPid, writeState } from '../visual/fixture.ts'
import { screens as gpuixScreens, type Fixture } from '../visual/screens.gpuix.ts'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const out = opt('out') ?? '/Users/mymac/projects/ade/previews/gpuix/visual'
const themeArg = opt('theme') ?? 'dark'
const themes = themeArg === 'both' ? ['dark', 'light'] : [themeArg]
const valueArgs = new Set(['--out', '--theme'])
const wanted = args.filter((a, i) => !a.startsWith('--') && !valueArgs.has(args[i - 1] ?? ''))
const names = wanted.length ? wanted : Object.keys(gpuixScreens)
const here = import.meta.dir
const desktop = path.resolve(here, '../../desktop')
mkdirSync(out, { recursive: true })

async function down() {
  const s = readState()
  if (s) { stopPid(s.vitePid); stopPid(s.daemonPid) }
}
if (flag('down')) { await down(); process.exit(0) }

let state = await startDaemon(flag('fresh'))
if (!state.seeded) { await seed(state); state = readState()! }
if (!state.vitePid) {
  const vitePort = 14321
  const child = spawn('pnpm', ['exec', 'vite', '--port', String(vitePort), '--strictPort'], { cwd: desktop, stdio: 'ignore', detached: true })
  child.unref()
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${vitePort}/`)).ok) break } catch {} await Bun.sleep(200) }
  state = { ...state, vitePid: child.pid, vitePort }
  writeState(state)
}

/** Ids of the seeded notes and tasks by title, so steps can open a specific one. */
async function fixtureIds(): Promise<Fixture> {
  const client = await connect(state)
  try {
    const notes = (await client.call('notes.list', {})).notes
    const tasks = (await client.call('tasks.items.list', {})).tasks
    return { notes: Object.fromEntries(notes.map((n) => [n.title, n.id])), tasks: Object.fromEntries(tasks.map((x) => [x.title, x.id])), taskKeys: Object.fromEntries(tasks.map((x) => [x.key, x.id])) }
  } finally { client.close?.() }
}
function run(cmd: string[], opts: { env?: Record<string, string> } = {}) {
  const r = Bun.spawnSync(cmd, { env: { ...process.env, ...opts.env }, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}\n${r.stderr.toString()}`)
  return r.stdout.toString()
}

const fixture = await fixtureIds()
try {
  for (const theme of themes) {
    if (!flag('gpuix-only')) console.log(run(['node', path.join(here, '../visual/tauri-shot.mjs'), JSON.stringify({ port: state.port, token: state.token, vite: state.vitePort, theme, screens: names, out })]).trim())
    // A fresh app per screen: an open note, task or menu must not leak into the next one.
    for (const name of names) {
      const step = gpuixScreens[name]
      if (!step) { console.log(`[gpuix] no step for ${name}`); continue }
      // Persisted UI state (last open note, layout, filters) must not leak between screens.
      rmSync(path.join(DATA_DIR, 'gpuix-ui.json'), { force: true })
      const app = await launch({
        command: 'bun',
        args: [path.join(here, '../src/main.tsx')],
        env: { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: DATA_DIR, KYBERN_REDUCED_MOTION: '1' },
      })
      try {
        await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
        await Bun.sleep(1800)
        await step(app, fixture)
        await app.screenshot({ path: path.join(out, `${name}-${theme}-gpuix.png`) })
      } finally {
        await app.close()
      }
      const base = path.join(out, `${name}-${theme}`)
      const res = run(['swift', path.join(here, '../visual/compose.swift'), `${base}-tauri.png`, `${base}-gpuix.png`, `${base}-pair.png`, `${base}-diff.png`])
      console.log(`[pair] ${name} ${theme}: ${res.trim()}`)
    }
  }
} finally {
  if (!flag('keep')) await down()
}
process.exit(0)
