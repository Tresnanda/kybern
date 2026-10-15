/** Two fresh-process samples, each with a 10s warm-up and 15s measurement. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { readFileSync } from 'node:fs'
import { until, openDock, absent } from '../../scripts/dock-waits.ts'
const data = process.env.KYBERN_DATA_DIR!, thread = process.env.KYBERN_GPUIX_THREAD!
assert.ok(data.includes('gpuix-scratch'))
const client = new KybernClient({ url: `ws://127.0.0.1:${readFileSync(`${data}/daemon.port`, 'utf8').trim()}/ws`, token: readFileSync(`${data}/daemon.token`, 'utf8').trim() }); client.connect()
await until(async () => client.status === 'open', 'scratch connection')
const changing = process.argv.includes('--changing')
const live = process.argv.includes('--live') || changing
const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const controlPort = probe.port!; probe.stop(true)
const control = async (action = '') => await fetch(`http://127.0.0.1:${controlPort}/${action}`).then(r => r.json()) as { frames: number; visible: boolean }
for (let round = 1; round <= 2; round++) {
  const app = await launch({ command: 'bun', args: [path.resolve(changing ? 'src/live/verify-changing.tsx' : 'scripts/dock2-fixture.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', DOCK2_LIVE: live ? '1' : '0', DOCK2_CONTROL_PORT: String(controlPort) } })
  const pid = (await app.call('initialize', { protocolVersion: 1, client: 'p5-perf' })).pid
  const sample = async (label: string, start?: () => Promise<void>) => {
    await Bun.sleep(10000)
    const process = Bun.spawn(['bun', 'perf/sample.ts', '15', `GPUIX=${pid}`], { stdout: 'pipe', stderr: 'inherit' })
    if (start) await start()
    console.log(`${label} round ${round}\n${await new Response(process.stdout).text()}`)
    assert.equal(await process.exited, 0)
  }
  try {
    await app.getByTestId('header-title').waitFor({ timeoutMs: 60000 })
    if (live) {
      await control('show'); await app.getByTestId('computer-live').waitFor({ timeoutMs: 30000 })
      let beforeFrames = 0
      await sample(changing ? 'live changing image' : 'live active', async () => { beforeFrames = (await control()).frames })
      const after = await control()
      assert.ok(after.visible && after.frames - beforeFrames >= 8, 'active sample must actually poll visible frames')
      console.log('visible frame requests during 15s sample', after.frames - beforeFrames)
      if (changing || process.argv.includes('--active-only')) continue
      await control('minimize'); await until(async () => !(await control()).visible, 'minimize')
      const count = (await control()).frames
      await sample('live minimized'); assert.equal((await control()).frames, count)
    } else {
      await app.getByTestId('app-ready').press('cmd-j'); await openDock(app.getByTestId('right-dock'))
      for (const tab of ['preview', 'terminal']) {
        await app.getByTestId('dock-add').click(); await app.getByTestId(`dock-add-${tab}`).click()
        await app.getByTestId(`dock-${tab}`).waitFor({ timeoutMs: 30000 })
        if (tab === 'preview') { await sample('preview idle'); continue }
        await app.getByTestId('terminal-screen').waitFor({ timeoutMs: 30000 })
        let terminal = ''
        await until(async () => { terminal = (await client.call('terminals.list', { thread_id: thread })).terminals.find(t => t.alive)?.id ?? ''; return !!terminal }, 'terminal')
        await sample('terminal idle')
        await sample('terminal 200000 lines', async () => { await client.call('terminals.input', { terminal_id: terminal, data: Buffer.from('yes | head -n 200000; printf "\\n__P5_DONE__\\n"\n').toString('base64') }) })
        await app.getByTestId('terminal-screen').press('cmd-end'); await until(async () => !!await app.getByText('__P5_DONE__').count(), 'final terminal output')
      }
    }
  } finally {
    await app.close()
    if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
    for (const terminal of (await client.call('terminals.list', { thread_id: thread })).terminals) await client.call('terminals.close', { terminal_id: terminal.id })
    // Reset the same fixture thread's persisted choice before its next fresh launch.
    const { unlinkSync } = await import('node:fs'); try { unlinkSync(path.join(data, 'gpuix-ui.json')) } catch {}
  }
}
client.close()
