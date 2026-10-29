/** The Pull requests list search: a click anywhere on the field (its glyph, padding or text) focuses it, typing filters the
 *  list, the clear circle empties it, and ⌘F focuses it from the list and from an open pull request. Mock RPC only.
 *
 *    bun src/pulls/verify.search.ts [--light]   (KYBERN_VERIFY_OUTPUT=<dir> for the screenshots) */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { captureWindow } from '../transcript/live.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/pr-search'
mkdirSync(out, { recursive: true })
const fixture = actionFixture({ readiness: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const shot = async (name: string) => { const file = `${out}/${name}-${mode}.png`; try { captureWindow(f.pid, file) } catch { await a.screenshot({ path: file }) } }
const painted = async () => { await a.clock.fastForward(16); return (await a.call('getPaintedText', {})).text.join('\n') }
const keys = (keys: string) => a.call('keystrokes' as never, { keys } as never)
const type = (text: string) => keys(text.split('').map(c => (c === ' ' ? 'space' : c)).join(' '))
const rows = async (...ids: string[]) => Promise.all(ids.map(id => a.getByTestId(`pr-row-${id}`).count()))
async function until(check: () => Promise<boolean>, label: string, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(100) }
  throw Error(`Timed out: ${label}`)
}
/** Clear the field with the keyboard (select all, delete) wherever focus is, then wait for every row to return. */
async function reset() {
  await a.getByTestId('pr-search').click(); await keys('cmd-a backspace')
  await until(async () => (await rows('core-2860', 'tele-1190')).every(n => n === 1), 'the list is unfiltered')
}
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await a.getByTestId('rail-pulls').click()
  await a.getByTestId('pr-row-core-2860').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(500)
  const input = await a.getByTestId('pr-search').bounds()
  // The shell (`kit/Field.tsx`): 10 px padding, the 14 px glyph and a 6 px gap before the input; padding after it.
  const field = { x: input.x - 30, y: input.y, width: input.width + 40, height: input.height }

  // Each part of the field focuses the input: its text area, the search glyph, the padding at either end.
  const spots: [string, number, number][] = [
    ['text', input.x + input.width / 2, input.y + input.height / 2],
    ['glyph', field.x + 17, field.y + field.height / 2],
    ['left padding', field.x + 3, field.y + field.height / 2],
    ['right padding', field.x + field.width - 3, field.y + field.height / 2],
  ]
  for (const [spot, x, y] of spots) {
    await a.getByTestId('pr-row-core-2860').click(); await Bun.sleep(150)
    await a.mouse.click({ x, y }); await Bun.sleep(150)
    const needle = `tele${spot.length}`
    await type('tele')
    await until(async () => (await painted()).includes('tele'), `typing after a click on the ${spot} lands in the field`)
    await until(async () => { const [core, tele] = await rows('core-2860', 'tele-1190'); return core === 0 && tele === 1 }, `the list filters after a click on the ${spot}`)
    if (spot === 'glyph') await shot('1-filtered')
    console.log(`PASS ${mode}: a click on the ${spot} focuses the search (${needle})`)
    await reset()
  }

  // The clear circle empties the field and the list comes back.
  await a.getByTestId('pr-search').click(); await type('1190')
  await until(async () => (await rows('core-2860'))[0] === 0, 'a number filters')
  await a.mouse.click({ x: input.x + input.width - 8, y: input.y + input.height / 2 })
  await until(async () => (await rows('core-2860', 'tele-1190')).every(n => n === 1), 'clear brings every row back')
  assert.equal(await a.getByTestId('pr-search-placeholder').count(), 1, 'the field is empty (its placeholder shows)')
  console.log(`PASS ${mode}: the clear circle empties the search`)

  // No results, then "Clear search".
  await a.getByTestId('pr-search').click(); await type('zzzz')
  await until(async () => (await painted()).includes('No results for'), 'the empty state')
  await shot('2-no-results')
  await a.getByText('Clear search').click()
  await until(async () => (await rows('core-2860'))[0] === 1, '"Clear search" brings rows back')
  console.log(`PASS ${mode}: "Clear search" in the empty state`)

  // ⌘F from the list, then from an open pull request.
  await a.getByTestId('pr-row-core-2860').click()
  await a.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 }); await Bun.sleep(400)
  await keys('cmd-f'); await type('tele')
  await until(async () => { const [core, tele] = await rows('core-2860', 'tele-1190'); return core === 0 && tele === 1 }, '⌘F from an open pull request focuses the search')
  await shot('3-cmd-f')
  console.log(`PASS ${mode}: ⌘F focuses the search with a pull request open`)
} catch (error) {
  await shot('failure').catch(() => {})
  console.log(f.diagnostics().slice(-3000))
  throw error
} finally { await f.close(); fixture.close() }
process.exit(0)
