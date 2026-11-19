// The composer tray stops real background tasks: a row's hover stop and "Stop all". Needs a scratch daemon with a thread
// whose agent left long `sleep` processes running in the background (a Claude thread asked to start a few `sleep 1800`
// with `run_in_background`).
//
//   KYBERN_DATA_DIR=<…/gpuix-scratch> bun src/requests/tray-stop.verify.ts <thread id> <out dir> [dark,light] [stop]
//
// Captures the tray with a row's stop showing and with "Stop all" in each theme; with `stop`, the last theme then stops one
// row and the rest with "Stop all", and checks the processes end.
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from './harness.ts'

const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch')) throw Error('Scratch daemon required')
const [thread = '', out = path.join(process.env.TMPDIR ?? '.', 'tray-stop'), themes = 'dark,light', act] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const sleeps = () => { try { return execFileSync('pgrep', ['-x', 'sleep', '-a'], { encoding: 'utf8' }).split('\n').filter(l => / 180\d$/.test(l)).length } catch { return 0 } }
const until = async (what: string, ok: () => Promise<boolean> | boolean, ms = 15000) => {
  const deadline = Date.now() + ms
  while (!(await ok())) { if (Date.now() > deadline) throw new Error(`timed out: ${what}`); await Bun.sleep(150) }
}

const list = themes.split(',')
for (const theme of list) {
  const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_NO_ACTIVATE: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: thread, KYBERN_URL: '' })
  const a = f.app
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
    await a.getByTestId('composer-tray').waitFor({ timeoutMs: 30000 })
    const ids = async () => (await a.getByType('div').all()).map(n => n.testId).filter((id): id is string => !!id)
    // Open the tray when it starts closed.
    if (!(await ids()).some(id => id.startsWith('runtime-task-'))) { const c = await a.getByTestId('composer-tray-toggle').center(); await a.mouse.click(c); await Bun.sleep(500) }
    const rows = async () => (await ids()).filter(id => /^runtime-task-(?!stop-)/.test(id))
    await until('task rows', async () => (await rows()).length >= 2)
    const first = (await rows())[0]!
    const row = await a.getByTestId(first).bounds()
    // Hover the first row: its clock trades places with the stop square.
    await a.mouse.move({ x: row.x + row.width / 2, y: row.y + row.height / 2 }); await Bun.sleep(400)
    await a.screenshot({ path: path.join(out, `tray-hover-stop-${theme}.png`) })
    await a.getByTestId('subagents-stop-all').waitFor({ timeoutMs: 5000 })
    const header = await a.getByTestId('subagents-stop-all').bounds()
    await a.mouse.move({ x: header.x + header.width / 2, y: header.y + header.height / 2 }); await Bun.sleep(300)
    await a.screenshot({ path: path.join(out, `tray-stop-all-${theme}.png`) })
    console.log(`${theme}: ${(await rows()).length} task rows, hover stop and "Stop all" captured`)

    if (act === 'stop' && theme === list[list.length - 1]) {
      const before = sleeps()
      assert.ok(before >= 3, `at least three background sleeps to stop (${before})`)
      await a.mouse.move({ x: row.x + row.width / 2, y: row.y + row.height / 2 }); await Bun.sleep(300)
      const stopId = first.replace('runtime-task-', 'runtime-task-stop-')
      const stop = await a.getByTestId(stopId).bounds()
      await a.mouse.click({ x: stop.x + stop.width / 2, y: stop.y + stop.height / 2 })
      await Bun.sleep(150)
      await a.screenshot({ path: path.join(out, `tray-stopping-${theme}.png`) })
      await until('one sleep ends after its row stop', () => sleeps() === before - 1, 20000)
      await until('its row leaves the tray', async () => !(await ids()).includes(first), 20000)
      console.log(`row stop: ${before} → ${sleeps()} sleeps, row ${first} gone`)
      const left = (await rows()).length
      await a.getByTestId('subagents-stop-all').click()
      await until('every sleep ends after Stop all', () => sleeps() === 0, 20000)
      await until('the tray has no task rows', async () => (await rows()).length === 0, 20000)
      await Bun.sleep(400)
      await a.screenshot({ path: path.join(out, `tray-after-stop-all-${theme}.png`) })
      console.log(`Stop all: ${left} rows stopped, ${sleeps()} sleeps left`)
    }
  } catch (error) {
    console.error(f.diagnostics().slice(-4000))
    throw error
  } finally { await f.close() }
}
process.exit(0)
