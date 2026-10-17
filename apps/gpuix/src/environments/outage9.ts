/**
 * settings9 (4.7/4.8): connect to a saved environment whose machine is down, then bring it back.
 * Daemon B (scratch, 4295) is stopped and restarted on the same data dir; the app must show the failure
 * for B only (A stays fine), keep B's saved connection, and reconnect when the machine returns.
 */
import { spawn, execFileSync } from 'node:child_process'
import { addSecond, DATA_B, mode, reset, start, switchTo, wait } from './verify9.lib.ts'
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`FAIL: ${message}`); console.log(`ok  ${message}`) }
const KYBERND = '/Applications/kybern.app/Contents/MacOS/kybernd'
const pidB = () => execFileSync('pgrep', ['-f', `kybernd --data-dir ${DATA_B}`], { encoding: 'utf8' }).trim().split('\n')[0]!
const startB = () => { const child = spawn(KYBERND, ['--data-dir', DATA_B, '--port', '4295'], { detached: true, stdio: 'ignore' }); child.unref() }
reset()
const h = await start()
let restarted = false
try {
  await wait(1200)
  const bId = await addSecond(h)
  await switchTo(h, 'local', 'proj9a')
  process.kill(Number(pidB()), 'SIGTERM')
  await h.until('daemon B stopped', async () => { try { pidB(); return false } catch { return true } }, 15000)
  await h.click('environment-switcher'); await h.click(`environment-choice-${bId}`)
  await h.until('failure shown for B', async () => (await h.text('Reconnect')) || (await h.text('Retry')) || (await h.text('Unable')) || (await h.text('failed')), 40000)
  await h.shot('o-01-b-down')
  assert(!(await h.text('proj9a')), 'the failed environment shows none of A\'s data')
  startB(); restarted = true
  await h.until('daemon B back', async () => { try { pidB(); return true } catch { return false } }, 15000)
  await wait(1500)
  // The banner's own reconnect, or the environment menu row of the current (failed) environment.
  await h.click('environment-switcher'); await h.click(`environment-choice-${bId}`)
  await h.until('B reconnected', () => h.text('proj9b'), 40000)
  await h.shot('o-02-b-back')
  assert(await h.text('proj9b'), 'choosing the failed environment again reconnects once its machine is back')
  await switchTo(h, 'local', 'proj9a')
  assert(await h.text('proj9a'), 'A was never affected')
  console.log(`PASS outage and reconnect (${mode}${process.env.KYBERN_REDUCED_MOTION === '1' ? ', reduced motion' : ''})`)
} catch (e) { await h.shot('o-failure'); throw e } finally {
  await h.app.close().catch(() => {})
  if (!restarted) { try { pidB() } catch { startB() } }
}
