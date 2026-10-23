/**
 * Live turns through the real path: the scratch daemon's Claude binary is
 * `apps/desktop/scripts/profile-replay-driver.py`, which streams a recorded
 * Claude Code session (KYBERN_PERF_REPLAY_JSONL on the daemon) for each
 * PROFILE_REPLAY message, so events cross the driver, the store and the
 * WebSocket exactly as a running agent's do. The app watches the thread while
 * passes run; footprint and JS heap are sampled every 30 s, with a full-GC
 * census after each pass.
 *
 *   KYBERN_DATA_DIR=<scratch daemon with the replay binary> bun perf/memlog/live.ts <label> <thread> [passes] [minutes per pass]
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { ensureTestDisplay } from '../glass/harness.ts'
import { assertTestDisplayWindow } from '../images/onscreen.ts'

const [label = 'live', thread, passesArg = '3', minutesArg = '6'] = process.argv.slice(2)
assert(thread, 'Name the thread')
const data = process.env.KYBERN_DATA_DIR!
assert(data?.includes('scratch'), 'Explicit scratch data directory required')
const cli = process.env.KYBERN_CLI ?? '/Applications/Kybern GPUIX.app/Contents/MacOS/kybern'
const out = path.join(data, 'results', label)
mkdirSync(out, { recursive: true })
const client = path.join(data, `client-${label}`)
mkdirSync(client, { recursive: true })
// Frames must be drawn: the leak this measures grows only while the window renders the stream.
const stopDisplay = await ensureTestDisplay(path.join(data, 'test-display'))
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
  KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_THREAD: '',
  GPUIX_BACKGROUND: '1', KYBERN_MEMORY_COUNTERS: '1', KYBERN_APPEARANCE: 'dark', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_MEMORY_LOG_MS: '15000',
})
const run = (args: string[]) => new Promise<number>(resolve => {
  const child = spawn(cli, ['--data-dir', data, ...args], { env: { HOME: path.join(data, 'home'), PATH: '/usr/bin:/bin' }, stdio: 'ignore' })
  child.on('exit', code => resolve(code ?? 1))
})
const rows: Record<string, unknown>[] = []
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = (name: string) => JSON.parse(readFileSync(path.join(client, `${name}-control.json`), 'utf8')).port as number
  for (const until = Date.now() + 20000; ; await Bun.sleep(50)) { try { port('memlog'); break } catch { assert(Date.now() < until) } }
  const call = async (name: string, action: string, args: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port(name)}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })).json() as Promise<Record<string, any>>
  const started = Date.now()
  const sample = async (name: string, census = false) => {
    const text = execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' })
    const size = (re: RegExp) => { const m = text.match(re); return m ? Math.round(Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : m[2] === 'B' ? 1 / 1048576 : 1)) : null }
    const category = (c: string) => size(new RegExp(`^\\s*([\\d.]+) (B|KB|MB|GB)\\s+[\\d.]+ \\w+\\s+[\\d.]+ \\w+\\s+\\d+\\s+${c.replace(/[()]/g, '\\$&')}$`, 'm'))
    const stats = await call('memory', 'stats')
    const row: Record<string, unknown> = {
      name, minutes: Math.round((Date.now() - started) / 6000) / 10, footprintMB: size(/phys_footprint:\s+([\d.]+) (\w+)/), peakMB: size(/phys_footprint_peak:\s+([\d.]+) (\w+)/),
      jsTagMB: category('App-Specific Tag 1'), untaggedMB: category('Untagged'), mallocSmallMB: category('Malloc Small'), ioAccelMB: category('IOAccelerator'),
      heapMB: Math.round(stats.heap.heapSize / 1048576), extraMB: Math.round(stats.heap.extraMemorySize / 1048576), objects: stats.heap.objectCount, blocks: stats.blocks,
    }
    if (census) { const c = await call('memlog', 'census'); row.liveHeapMB = Math.round(c.heapSize / 1048576); row.liveExtraMB = Math.round(c.extra / 1048576); row.types = c.types }
    rows.push(row)
    writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 2))
    const { types: _, ...brief } = row
    console.log(JSON.stringify(brief))
  }
  while (!(await call('bench', 'state')).listsLoaded) await Bun.sleep(50)
  await assertTestDisplayWindow(f.pid)
  await call('bench', 'open', { thread }); await Bun.sleep(4000)
  await sample('open', true)
  for (let pass = 1; pass <= Number(passesArg); pass++) {
    await run(['send', '--detach', thread, 'PROFILE_REPLAY'])
    const until = Date.now() + Number(minutesArg) * 60000
    // With the display asleep nothing paints; KYBERN_LIVE_FORCE_FRAMES_MS forces a render (an automation capture) at that pace.
    const forceMs = Number(process.env.KYBERN_LIVE_FORCE_FRAMES_MS ?? 0)
    let forcing = forceMs > 0
    const shot = path.join(out, 'frame.png')
    const force = (async () => { while (forcing && Date.now() < until) { try { await f.app.screenshot({ path: shot }) } catch { /* Next one. */ } await Bun.sleep(forceMs) } })()
    while (Date.now() < until) {
      await Bun.sleep(30000)
      await sample(`pass-${pass}`)
      if ((await call('bench', 'state')).threads?.find?.((t: { id: string; status: string }) => t.id === thread)?.status === 'idle') break
    }
    forcing = false; await force
    await run(['interrupt', thread]); await Bun.sleep(5000)
    await sample(`pass-${pass}-end`, true)
  }
  if (process.env.KYBERN_SESSION_SNAPSHOT === '1') { await call('memlog', 'snapshot', { file: path.join(out, 'heap.json') }); console.log('snapshot', path.join(out, 'heap.json')) }
} finally {
  await f.close()
  stopDisplay()
}
