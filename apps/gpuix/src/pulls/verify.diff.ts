/** Exercise the app integration against the existing in-memory PR fixture. */
import assert from 'node:assert/strict'
import { launchFixture, waitForPainted } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'
const fixture = actionFixture()
const f = await launchFixture(import.meta.dir + '/../main.tsx', { ...fixture.env, GPUIX_BACKGROUND: '1' })
try {
  const app = f.app
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await app.getByTestId('rail-pulls').click()
  await app.getByTestId('pr-row-108').waitFor()
  await app.getByTestId('pr-row-108').click()
  await app.getByTestId('pr-summary').waitFor()
  await app.getByTestId('pr-tab-changes').click()
  await app.getByTestId('pr-native-diff').waitFor()
  await waitForPainted(app, 'renderOld(0)')
  const b = await app.getByTestId('pr-native-diff').bounds()
  assert.ok(b.height > 400, `Diff should fill the pane: ${b.height}`)
  await app.mouse.click({ x: b.x + 22, y: b.y + 35 })
  await app.getByTestId('pr-inline-body').waitFor()
  assert.match((await app.call('getPaintedText', {})).text.join('\n'), /original version/)
  await app.getByText('Cancel').click()
  await app.mouse.wheel({ x: b.x + 200, y: b.y + 100 }, 0, -100000)
  await waitForPainted(app, 'Show 600 more lines')
  const scrolled = await app.getByTestId('pr-native-diff').bounds()
  await app.mouse.click({ x: scrolled.x + scrolled.width / 2, y: scrolled.y + scrolled.height - 15 })
  await app.mouse.wheel({ x: b.x + 200, y: b.y + 100 }, 0, -100000)
  await waitForPainted(app, 'renderStable(599)')
  await app.getByTestId('pr-file-1').click()
  await waitForPainted(app, 'renderOld(0)')
  assert.ok((await app.call('getPaintedText', {})).text.length < 600)
  console.log('PASS PR diff: full-height viewport, original-line anchor, vertical scroll, 600-line expansion, file-switch reset, bounded paint')
} finally { await f.close(); fixture.close() }
