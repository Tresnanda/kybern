// Message navigation rail on a real long thread: the rail exists, hovering a tick shows the preview card,
// and clicking a tick jumps the transcript so a different part of the thread is painted.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { EVIDENCE, launchLive, until } from './live.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/rail`
mkdirSync(out, { recursive: true })
for (const [theme, reduced] of [['dark', false], ['light', false], ['dark', true], ['light', true]] as const) {
  const label = `${theme}${reduced ? '-reduced' : ''}`
  const f = await launchLive({ theme, reduced, thread: 'Long review thread' })
  try {
    const app = f.app
    const text = async () => { await app.clock.fastForward(16); await app.screenshot({ path: `${out}/.flush.png` }); return String((await app.call('getPaintedText', {})).text) }
    await until(async () => (await app.getByTestId('message-rail').count()) > 0, 'rail', 30000)
    const before = await text()
    const jumps = await app.getByTestId('message-rail').count()
    const first = app.getByTestId('message-jump-0')
    await until(async () => (await first.count()) > 0, 'first tick', 10000)
    await first.hover()
    await until(async () => (await app.getByTestId('message-preview').count()) > 0, 'preview card on hover', 10000)
    await app.screenshot({ path: `${out}/hover-${label}.png` })
    await first.click()
    await until(async () => (await text()) !== before, 'jump changes the painted transcript', 10000)
    await app.screenshot({ path: `${out}/jumped-${label}.png` })
    console.log(`PASS ${label}: rail present (${jumps}), hover preview, tick jumps`)
  } catch (error) { await f.app.screenshot({ path: `${out}/failed-${label}.png` }).catch(() => {}); throw error } finally { await f.close() }
}
process.exit(0)
