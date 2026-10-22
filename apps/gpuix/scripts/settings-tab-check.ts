/** Scratch-only: Tab on the Settings page moves focus one stop (GPUIX 0.11 does it by default; the page used to). */
import '../src/native/local-build.ts'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launchFixture } from '../src/requests/harness.ts'

const dir = process.env.KYBERN_DATA_DIR
if (!dir?.includes('gpuix-scratch')) throw new Error('Set KYBERN_DATA_DIR to the GPUIX scratch daemon')
const f = await launchFixture(path.join(import.meta.dir, '../src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark' }), a = f.app
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const press = async (keys: string) => { await a.call('keystrokes', { keys }); await wait(150) }
// The renderer does not report which element is focused from outside the process, so probe it
// the way a user would: typed text only lands in the search field when the search field has focus.
const probe = async () => {
  await a.call('keystrokes', { keys: 'z z' }); await wait(250)
  const text = await a.getByTestId('page-settings').textContent()
  return text.includes('No settings match “zz”')
}
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await wait(1000)
  await a.getByTestId('rail-settings').click()
  await a.getByTestId('settings-back').waitFor()
  await wait(800)
  // "Back to workspace" has autoFocus; the search field is the next stop and the tab rows follow.
  assert.equal(await probe(), false, 'typing on "Back to workspace" does not reach the search field')
  await press('tab')
  assert.equal(await probe(), true, 'one Tab lands on the search field, not past it')
  await press('escape') // clears the query and keeps focus in the field
  await press('tab')
  assert.equal(await probe(), false, 'the second Tab leaves the search field for the first tab row')
  await press('shift-tab')
  assert.equal(await probe(), true, 'Shift+Tab goes back exactly one stop')
  console.log('ok  Settings: Tab and Shift+Tab move focus one stop each (no double move)')
} catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
