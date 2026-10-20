/**
 * settings9: what an open environment dialog costs while idle (Pair a device polls the device list every 5 s).
 * 10 s warm-up, then `perf/sample.ts 15`. KYBERN_FULL_RATE is not set. Scratch daemons only, no screenshots during the run.
 */
import { execFileSync } from 'node:child_process'
import { reset, start, wait } from './verify9.lib.ts'
reset()
const h = await start()
const sample = (label: string, pid: string) => { const out = execFileSync('bun', ['perf/sample.ts', '15', `GPUIX=${pid}`], { encoding: 'utf8' }); console.log(`--- ${label}\n${out.trim()}`) }
try {
  await wait(1500)
  const pid = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n')[0]!
  await wait(10_000); sample('home idle, no dialog', pid)
  await h.click('environment-switcher'); await h.click('environment-pair'); await h.app.getByTestId('pairing-create').waitFor()
  await wait(10_000); sample('Pair a device open (5 s device poll, 250 ms window-size poll)', pid)
  await h.click('dialog-close'); await h.click('environment-switcher'); await h.click('environment-manage'); await h.app.getByTestId('environment-manage-list').waitFor()
  await wait(10_000); sample('Manage environments open', pid)
  await h.click('dialog-close'); await wait(10_000); sample('dialog closed again', pid)
} finally { await h.app.close() }
