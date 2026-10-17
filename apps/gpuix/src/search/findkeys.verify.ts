// ⌘F parity: the desktop binds `mod+f` only on the Notes gallery and the Pull requests list (focus + select the
// search field, allowed while typing). There is no find-in-thread in the desktop transcript, so GPUIX has none.
// Checks ⌘F on both pages in the real app: it focuses the field, so typing lands in it.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { EVIDENCE, launchLive, until } from '../transcript/live.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/findkeys`
mkdirSync(out, { recursive: true })
for (const [theme, reduced] of [['dark', false], ['light', true]] as const) {
  const label = `${theme}${reduced ? '-reduced' : ''}`
  const f = await launchLive({ theme, reduced, thread: 'Markdown B' })
  try {
    const app = f.app
    const text = async () => { await app.clock.fastForward(16); await app.screenshot({ path: `${out}/.flush.png` }); return String((await app.call('getPaintedText', {})).text) }
    await until(async () => (await app.getByTestId('rail-notes').count()) > 0, 'rail', 30000)
    for (const [page, field, away] of [['notes', 'notes-search', 'notes-gallery'], ['pulls', 'pr-search', 'rail-' + 'pulls']] as const) {
      await app.getByTestId(`rail-${page}`).click()
      await until(async () => (await app.getByTestId(field).count()) > 0, `${page} search field`, 15000)
      await Bun.sleep(800)
      await app.getByTestId(away).click().catch(() => {})
      const needle = 'xyzzyq' + page
      assert.ok(!(await text()).includes(needle))
      await app.call('keystrokes' as never, { keys: 'cmd-f' } as never)
      await app.call('keystrokes' as never, { keys: needle.split('').join(' ') } as never)
      await until(async () => (await text()).includes(needle), `⌘F focuses the ${page} search and typing lands`, 10000)
      await app.screenshot({ path: `${out}/${page}-${label}.png` })
      console.log(`PASS ${label}: ⌘F on ${page} focuses the search field`)
    }
  } catch (error) { await f.app.screenshot({ path: `${out}/failed-${label}.png` }).catch(() => {}); throw error } finally { await f.close() }
}
process.exit(0)
