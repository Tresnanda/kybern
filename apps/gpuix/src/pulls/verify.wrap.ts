/** The Changes view's Wrap lines: a long-lined TypeScript file wrapped (the default) and unwrapped, then a line comment on
 * a wrapped row, screenshotted (`--light` for the light theme). */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture, waitForPainted } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/tmp/gpuix-wrap'
mkdirSync(out, { recursive: true })
const fixture = actionFixture({ wrap: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode, KYBERN_WINDOW_SIZE: '1360x860' })
const a = f.app
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(350) }
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-pulls')
  await click('pr-row-108')
  await a.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 })
  await click('pr-tab-changes')
  await a.getByTestId('pr-native-diff').waitFor({ timeoutMs: 10000 })
  await waitForPainted(a, 'Loads every review thread')
  await Bun.sleep(600)
  await a.screenshot({ path: `${out}/wrapped-${mode}.png` })
  await click('pr-diff-wrap'); await Bun.sleep(400)
  await a.screenshot({ path: `${out}/unwrapped-${mode}.png` })
  await click('pr-diff-wrap'); await Bun.sleep(400)
  // A click on the second visual line of the wrapped doc comment (new line 2) drafts a comment on that line.
  const b = await a.getByTestId('pr-native-diff').bounds()
  await a.mouse.click({ x: b.x + b.width / 2, y: b.y + 30 + 21.45 * 6 + 21.45 * 1.5 }); await Bun.sleep(500)
  await a.getByTestId('pr-inline-body').waitFor({ timeoutMs: 5000 })
  await waitForPainted(a, 'Comment on line 2 · new version · src/review/loadReviewThreads.ts')
  await a.screenshot({ path: `${out}/wrapped-comment-${mode}.png` })
  console.log(`PASS wrap ${mode}`)
} catch (error) {
  await a.screenshot({ path: `${out}/failure-${mode}.png` }).catch(() => {})
  console.log(f.diagnostics())
  throw error
} finally { await f.close(); fixture.close() }
