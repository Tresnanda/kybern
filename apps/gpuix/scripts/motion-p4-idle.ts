// Idle after motion on every P4 page: open the page (and the motion it plays), park the pointer, wait for it to settle, then count the
// frames the window presents over 3 s. Every page must reach 0 (no loops, no timers asking for frames). Real clock, no screenshots.
//   VISUAL_SCRATCH=… VISUAL_DAEMON_PORT=… bun native/ui-lease.ts <lane> bun scripts/motion-p4-idle.ts
import '../src/native/local-build.ts'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { connect, readState } from '../visual/fixture.ts'
import { ids as startSettingsProxy } from '../visual/fixture.settings.ts'

const SCRATCH = process.env.VISUAL_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const client = await connect(readState()!)
await startSettingsProxy(client)
await fetch(`http://127.0.0.1:${readState()!.port}/mode?value=s9-rich`)
const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: process.env.THEME ?? 'dark', KYBERN_FRAME_TIMES: '1', KYBERN_WINDOW_SIZE: '1280x820',
  KYBERN_DATA_DIR: `${SCRATCH}/data`, KYBERN_CLIENT_CONFIG_DIR: `${SCRATCH}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${SCRATCH}/credentials`, KYBERN_URL: process.env.KYBERN_URL!, KYBERN_TOKEN: process.env.KYBERN_TOKEN!,
})
const a = f.app
const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.click(c) }
const out: Record<string, number> = {}
async function idle(name: string, open: () => Promise<void>) {
  try {
    await open()
    await a.mouse.move({ x: 1275, y: 815 }); await sleep(2500)
    const mark = f.frameTimes().length
    await sleep(3000)
    out[name] = f.frameTimes().length - mark
  } catch (e) { out[name] = -1; console.log('FAILED', name, String(e).slice(0, 160)) }
}
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await sleep(3000)
  const notes = (await client.call('notes.list', {})).notes, tasks = (await client.call('tasks.items.list', {})).tasks
  await idle('notes gallery', () => click('rail-notes'))
  await idle('notes gallery filter', () => click('notes-filter-global'))
  await click('notes-filter-all')
  await idle('note open', () => click(`note-card-${notes.find(n => n.title === 'Sprint planning')!.id}`))
  await a.getByTestId('app-ready').press('escape')
  await idle('tasks list', () => click('rail-tasks'))
  await idle('task selected', async () => { const row = tasks[0]!.id; await a.mouse.move(await a.getByTestId(`task-row-${row}`).center()); await sleep(300); await click(`task-select-${row}`) })
  await a.getByTestId('app-ready').press('escape')
  await idle('tasks projects folded', () => click('task-projects-toggle'))
  await click('task-projects-toggle')
  await idle('tasks board', () => click('task-view-board'))
  await click('task-view-list')
  await idle('pull requests', () => click('rail-pulls'))
  await idle('pull request detail', () => click('pr-row-108'))
  await idle('pull request changes', () => click('pr-tab-changes'))
  await idle('usage', () => click('rail-usage'))
  await idle('usage group', () => click('usage-group-model'))
  await idle('settings', () => click('rail-settings'))
  await idle('settings appearance', () => click('settings-tab-appearance'))
  await idle('settings background', () => click('settings-tab-background'))
  console.log(JSON.stringify(out, null, 1))
} finally { await f.close(); client.close?.() }
process.exit(0)
