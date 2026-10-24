// The optimistic new chat in the real app against a scratch daemon: Enter → thread page latency in local and worktree mode,
// frames of the send in both (worktree mode shows "Preparing worktree…" while the daemon makes it), and a create that fails
// (worktree mode in a folder that is not a git repository) with its Retry after the folder becomes one.
//
//   KYBERND=<checkout>/target/debug/kybernd bun src/draft/optimistic.verify.ts <evidence dir> [--latency-only]
//
// `GPUIX_APP_ROOT=<another checkout>/apps/gpuix` measures that checkout's client against the same daemon (the "before").
// The daemon is a fresh scratch one (`visual/fixture.ts`), with a stub `claude` that fails every turn, so no agent runs.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR, SCRATCH, connect, startDaemon, stopPid } from '../../visual/fixture.ts'
import { launchFixture } from '../requests/harness.ts'
import { percentile, until } from '../transcript/live.ts'

const out = process.argv[2] ?? '/Users/mymac/projects/ade/.kybern-artifacts/v015/L2'
const latencyOnly = process.argv.includes('--latency-only')
const label = process.env.LATENCY_LABEL ?? 'after'
mkdirSync(out, { recursive: true })
const APP_ROOT = process.env.GPUIX_APP_ROOT ?? path.resolve(import.meta.dir, '../..')
const ORIGINAL_PATH = process.env.PATH!
const ADDON = process.env.NAPI_RS_NATIVE_LIBRARY_PATH
if (!process.env.KYBERND) throw Error('Set KYBERND to a kybernd that accepts client thread ids (this checkout’s target/debug/kybernd).')

// ---- the scratch daemon, with a stub agent ----
const bin = path.join(SCRATCH, 'stub-bin')
mkdirSync(bin, { recursive: true })
writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.9.0 (Claude Code)"; exit 0; fi\nsleep 1\nexit 1\n')
chmodSync(path.join(bin, 'claude'), 0o755)
process.env.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`
const state = await startDaemon(true)
process.env.PATH = ORIGINAL_PATH
const daemon = await connect(state)
{
  const settings = await daemon.call('settings.get', {} as never) as Record<string, any>
  const providers: Record<string, unknown> = { ...settings.providers }
  for (const kind of ['codex', 'opencode', 'pi', 'omp', 'cursor']) providers[kind] = { ...(providers[kind] as object), binary: path.join(SCRATCH, 'no-such-binary') }
  providers['claude-code'] = { ...(providers['claude-code'] as object), binary: path.join(bin, 'claude') }
  await daemon.call('settings.update', { settings: { ...settings, default_provider: 'claude-code', generate_titles: false, providers } } as never)
  const listed = await daemon.call('providers.list', {} as never) as { providers: { kind: string; available: boolean }[] }
  const live = listed.providers.filter((p) => p.available).map((p) => p.kind)
  if (live.some((kind) => kind !== 'claude-code' && kind !== 'cursor')) throw Error(`Refusing to send: a real harness is available (${live.join(', ')})`)
}

const projectsDir = path.join(SCRATCH, 'projects')
rmSync(projectsDir, { recursive: true, force: true })
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.com', ...args], { cwd })
async function project(name: string, opts: { git?: boolean; worktree?: boolean; slowWorktree?: boolean } = {}) {
  const dir = path.join(projectsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`)
  if (opts.git !== false) {
    git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'readme')
    // `git worktree add` runs post-checkout: a slow hook stands in for a large checkout.
    if (opts.slowWorktree) { writeFileSync(path.join(dir, '.git/hooks/post-checkout'), '#!/bin/sh\nsleep 2\n'); chmodSync(path.join(dir, '.git/hooks/post-checkout'), 0o755) }
  }
  const { id } = await daemon.call('projects.add', { path: dir, name })
  if (opts.worktree) await daemon.call('projects.update', { project_id: id, worktrees_default: true })
  return { id, dir }
}
const local = await project('gallery-local')
const worktree = await project('gallery-worktree', { worktree: true, slowWorktree: true })
const quickWorktree = await project('gallery-quick-worktree', { worktree: true })
const broken = await project('gallery-not-a-repo', { git: false, worktree: true })

// ---- the app ----
const report: Record<string, unknown> = { label, appRoot: APP_ROOT }
/** `[launch] enter→page N ms` lines the app logs under `KYBERN_LAUNCH_LOG=1` (`draft/store.ts`). */
const opened: number[] = []
async function launch(extra: Record<string, string> = {}) {
  rmSync(path.join(DATA_DIR, 'gpuix-ui.json'), { force: true })
  rmSync(CLIENT_DIR, { recursive: true, force: true }); mkdirSync(CLIENT_DIR, { recursive: true })
  const f = await launchFixture(path.join(APP_ROOT, 'src/main.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: DATA_DIR, KYBERN_URL: '', KYBERN_TOKEN: '',
    KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_ENVIRONMENT_NAME: 'Development environment',
    KYBERN_REDUCED_MOTION: '0', KYBERN_WINDOW_SIZE: '1280x820', KYBERN_OPAQUE: '1', KYBERN_LAUNCH_LOG: '1', PATH: ORIGINAL_PATH,
    ...(ADDON ? { NAPI_RS_NATIVE_LIBRARY_PATH: ADDON } : {}),
    ...extra,
  }, { stderr: (chunk) => { for (const m of chunk.matchAll(/\[launch\] enter→page ([\d.]+) ms/g)) opened.push(Number(m[1])) } })
  await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await f.app.getByTestId('draft-hero').waitFor({ timeoutMs: 30_000 })
  await until(async () => { await f.app.clock.fastForward(50); return (await f.app.getByTestId('model-picker').count()) > 0 }, 'agent list', 30000)
  await Bun.sleep(1200)
  await f.app.clock.fastForward(700)
  return f
}
type Fixture = Awaited<ReturnType<typeof launch>>
const settle = (f: Fixture, ms = 700) => f.app.clock.fastForward(ms)
const shot = async (f: Fixture, name: string) => { await settle(f, 32); await f.app.screenshot({ path: `${out}/${name}.png` }) }
async function pickProject(f: Fixture, id: string) {
  await f.app.getByTestId('heading-project').click()
  await f.app.getByTestId(`heading-project-${id}`).waitFor()
  await f.app.getByTestId(`heading-project-${id}`).click()
  await settle(f)
}

/** Enter → the thread page mounts, as the app measures it (Enter's handler to the page claiming its launch). */
async function latency(projectId: string, prompt: string): Promise<number> {
  const f = await launch()
  try {
    await pickProject(f, projectId)
    await f.app.getByTestId('composer').fill(prompt)
    await Bun.sleep(300)
    const seen = opened.length
    await f.app.getByTestId('composer').press('enter')
    await until(async () => opened.length > seen, 'the page logs its launch', 20000)
    return opened[seen]!
  } finally { await f.close() }
}

const latencies: Record<string, number[]> = { local: [], worktree: [], 'worktree, 2 s checkout': [] }
for (let i = 0; i < 3; i++) {
  latencies.local!.push(await latency(local.id, `Local sample ${i + 1}: tidy the gallery grid.`))
  latencies.worktree!.push(await latency(quickWorktree.id, `Worktree sample ${i + 1}: tidy the gallery grid.`))
}
latencies['worktree, 2 s checkout']!.push(await latency(worktree.id, 'Slow worktree sample: tidy the gallery grid.'))
report.enterToPageMs = Object.fromEntries(Object.entries(latencies).map(([mode, xs]) => [mode, { samples: xs, p50: percentile(xs, 0.5) }]))

/** Frames of one send with the motion clock held, from Enter. */
async function frames(name: string, projectId: string, prompt: string, extra: Record<string, string> = {}, after?: (f: Fixture) => Promise<void>) {
  const f = await launch(extra)
  try {
    await pickProject(f, projectId)
    await f.app.getByTestId('composer').fill(prompt)
    await Bun.sleep(400)
    await shot(f, `${name}-before`)
    await f.app.clock.pause()
    await f.app.getByTestId('composer').press('enter')
    await until(async () => { await f.app.clock.fastForward(1); return (await f.app.getByTestId('draft').count()) === 0 }, 'thread page', 20000)
    let at = 0
    for (const ms of [0, 40, 90, 150, 220, 320, 450, 700]) {
      await f.app.clock.fastForward(Math.max(1, ms - at)); at = Math.max(at + 1, ms)
      await f.app.screenshot({ path: `${out}/${name}-${String(ms).padStart(3, '0')}ms.png` })
    }
    await f.app.clock.resume()
    await after?.(f)
  } catch (error) { await f.app.screenshot({ path: `${out}/failed-${name}.png` }).catch(() => {}); console.log(f.diagnostics().slice(-3000)); throw error } finally { await f.close() }
}

if (!latencyOnly) {
  const prompt = 'Make the lightbox zoom follow trackpad pinch on Safari, and keep the image sharp while it scales.'
  await frames('local', local.id, prompt)
  await frames('local-reduced', local.id, prompt, { KYBERN_REDUCED_MOTION: '1' })
  await frames('worktree', worktree.id, prompt, {}, async (f) => {
    // Still preparing (the hook sleeps 2 s); then the first turn runs (and the stub agent fails it).
    await shot(f, 'worktree-preparing')
    report.preparingShown = (await f.app.getByText('Preparing worktree…').count()) > 0
    await Bun.sleep(2600)
    await shot(f, 'worktree-started')
  })
  await frames('failure', broken.id, 'Start the gallery redesign.', {}, async (f) => {
    await until(async () => { await settle(f, 50); return (await f.app.getByTestId('send-failed').count()) > 0 }, 'failed state', 20000)
    await shot(f, 'failure-not-sent')
    const before = (await daemon.call('threads.list', {})).threads.filter((t: { project_id: string }) => t.project_id === broken.id).length
    // The folder becomes a repository; Retry creates the same thread (the daemon re-probes `is_git`).
    git(broken.dir, 'init', '-q', '-b', 'main'); git(broken.dir, 'add', '.'); git(broken.dir, 'commit', '-qm', 'readme')
    await f.app.getByTestId('send-retry').click()
    await until(async () => { await settle(f, 50); return (await f.app.getByTestId('send-failed').count()) === 0 }, 'retry accepted', 20000)
    await Bun.sleep(1500)
    await shot(f, 'failure-retried')
    const threads = (await daemon.call('threads.list', {})).threads.filter((t: { project_id: string }) => t.project_id === broken.id)
    report.failure = { rowsBeforeRetry: before, rowsAfterRetry: threads.length, title: threads[0]?.title }
  })
}

if (!latencyOnly) {
  // Up next → Send with nothing typed: the run's thread opens at once and `tasks.items.send` records the run in it.
  await daemon.call('tasks.items.create', { scope: 'project', project_id: local.id, title: 'Uploads fail over 20 MB', priority: 1, status: 'todo' })
  {
    const f = await launch()
    try {
      await pickProject(f, local.id)
      const pickup = await f.app.getByTestId('draft-pickup').bounds()
      const row = { x: pickup.x + pickup.width * 0.75, y: pickup.y + 20 + 4 + 16 }
      await f.app.mouse.move(row); await f.app.mouse.down(row); await f.app.mouse.up(row)
      await settle(f)
      await f.app.getByTestId('draft-attached-task').waitFor()
      await f.app.getByTestId('send').click()
      await until(async () => { await settle(f, 20); return (await f.app.getByTestId('draft').count()) === 0 }, 'task thread opens', 20000)
      await shot(f, 'task-sent-000ms')
      await Bun.sleep(1500)
      await settle(f, 800)
      await shot(f, 'task-sent')
      const { tasks } = await daemon.call('tasks.items.list', {}) as { tasks: { title: string; runs: { thread_id: string }[] }[] }
      const task = tasks.find((t) => t.title === 'Uploads fail over 20 MB')!
      const rows = (await daemon.call('threads.list', {})).threads.filter((t: { title: string }) => t.title === 'Uploads fail over 20 MB')
      report.task = { runs: task.runs.length, rows: rows.length, runInThatRow: task.runs[0]?.thread_id === rows[0]?.id }
    } finally { await f.close() }
  }
  // The Coordinator: opened with the client's id; its setup starts with the user's words.
  {
    const f = await launch()
    try {
      await f.app.getByTestId(`create-coordinator-${local.id}`).click()
      await settle(f)
      await f.app.getByTestId('composer').fill('Ship the gallery redesign by Friday.')
      await Bun.sleep(300)
      await f.app.getByTestId('composer').press('enter')
      await until(async () => { await settle(f, 20); return (await f.app.getByTestId('draft').count()) === 0 }, 'coordinator opens', 20000)
      await shot(f, 'coordinator-000ms')
      await Bun.sleep(1500)
      await settle(f, 800)
      await shot(f, 'coordinator-sent')
      const coordinator = await daemon.call('coordinator.get', { project_id: local.id })
      const rows = (await daemon.call('threads.list', {})).threads.filter((t: { coordinator_project_id?: string | null }) => t.coordinator_project_id === local.id)
      report.coordinator = { rows: rows.length, id: coordinator?.id }
    } finally { await f.close() }
  }
}

writeFileSync(`${out}/report-${label}.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
daemon.close?.()
if (!process.env.KEEP) { stopPid(state.daemonPid); rmSync(path.join(SCRATCH, 'state.json'), { force: true }) }
process.exit(0)
