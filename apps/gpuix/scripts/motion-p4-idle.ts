// Idle after motion on every P4 page: open the page (and the motion it plays), park the pointer, wait for it to settle, then count the
// frames the window presents over 3 s. Every page must reach 0 (no loops, no timers asking for frames). Real clock, no screenshots.
// The once-a-minute refresh of relative times ("2m ago") is one commit and one frame; `late frames` shows when a frame landed.
//   VISUAL_SCRATCH=… VISUAL_DAEMON_PORT=… bun native/ui-lease.ts <lane> bun scripts/motion-p4-idle.ts
import '../src/native/local-build.ts'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { connect, readState } from '../visual/fixture.ts'
import { ids as startSettingsProxy } from '../visual/fixture.settings.ts'

const SCRATCH = process.env.VISUAL_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p4'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const client = await connect(readState()!)
await startSettingsProxy(client)
await fetch(`http://127.0.0.1:${readState()!.port}/mode?value=s9-rich`)
// Start from the default pages (no note left open by an earlier run), like the strips.
writeFileSync(`${SCRATCH}/data/gpuix-ui.json`, '{}')
rmSync(`${SCRATCH}/client`, { recursive: true, force: true })
const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: process.env.THEME ?? 'dark', KYBERN_FRAME_TIMES: '1', KYBERN_WINDOW_SIZE: '1280x820',
  KYBERN_DATA_DIR: `${SCRATCH}/data`, KYBERN_CLIENT_CONFIG_DIR: `${SCRATCH}/client`, KYBERN_GPUIX_CREDENTIALS_DIR: `${SCRATCH}/credentials`, KYBERN_URL: process.env.KYBERN_URL!, KYBERN_TOKEN: process.env.KYBERN_TOKEN!,
})
const a = f.app
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10_000 }); const c = await a.getByTestId(id).center(); await a.mouse.click(c) }
const quietly = (p: Promise<unknown>) => p.catch(e => console.log('FAILED step', String(e).slice(0, 120)))
const out: Record<string, number> = {}, late: Record<string, number[]> = {}
async function idle(name: string, open: () => Promise<void>) {
  if (process.env.IDLE_ONLY && !process.env.IDLE_ONLY.split(',').includes(name)) { await open().catch(() => {}); return }
  try {
    await open()
    await a.mouse.move({ x: 1275, y: 815 })
    // Frames presented in each 250 ms after the pointer parked; the last 3 s (12 buckets) must be empty.
    const buckets: number[] = []
    let seen = f.frameTimes().length
    for (let i = 0; i < 22; i++) { await sleep(250); const n = f.frameTimes().length; buckets.push(n - seen); seen = n }
    console.error('[idle-mark]', name)
    out[name] = buckets.slice(10).reduce((x, y) => x + y, 0)
    if (out[name]) late[name] = buckets
  } catch (e) { out[name] = -1; console.log('FAILED', name, String(e).slice(0, 160)) }
}
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 }); await sleep(3000)
  const notes = (await client.call('notes.list', {})).notes
  await idle('notes gallery', () => click('rail-notes'))
  await idle('notes gallery filter', () => click('notes-filter-global'))
  await quietly(click('notes-filter-all'))
  await idle('note open', () => click(`note-card-${notes.find(n => n.title === 'Sprint planning')!.id}`))
  await quietly(a.getByTestId('app-ready').press('escape'))
  await idle('tasks list', () => click('rail-tasks'))
  await idle('task selected', async () => {
    let row = ''
    for (const n of await a.getByType('div').all()) if (n.testId?.startsWith('task-row-') && n.bounds && n.bounds.y > 80 && n.bounds.y < 600) { row = n.testId.slice(9); break }
    await a.mouse.move(await a.getByTestId(`task-row-${row}`).center()); await sleep(300); await click(`task-select-${row}`)
  })
  await quietly(a.getByTestId('app-ready').press('escape'))
  await idle('tasks projects folded', () => click('task-projects-toggle'))
  await quietly(click('task-projects-toggle'))
  await idle('tasks board', () => click('task-view-board'))
  await quietly(click('task-view-list'))
  await idle('pull requests', () => click('rail-pulls'))
  await idle('pull request detail', () => click('pr-row-108'))
  await idle('pull request changes', () => click('pr-tab-changes'))
  await idle('usage', () => click('rail-usage'))
  await idle('usage group', () => click('usage-group-model'))
  await idle('settings', () => click('rail-settings'))
  await idle('settings appearance', () => click('settings-tab-appearance'))
  await idle('settings background', () => click('settings-tab-background'))
  console.log(JSON.stringify(out, null, 1))
  if (Object.keys(late).length) console.log('late frames', JSON.stringify(late))
  if (process.env.IDLE_SHOT) await a.screenshot({ path: process.env.IDLE_SHOT })
} finally { await f.close(); client.close?.() }
process.exit(0)
