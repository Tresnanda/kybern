/** The Changes view's syntax colours: a TypeScript and a Rust file, screenshotted (`--light` for the light theme). */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture, waitForPainted } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/tmp/gpuix-syntax'
mkdirSync(out, { recursive: true })
const fixture = actionFixture({ syntax: true })
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
  for (const [index, name, text] of [[0, 'rust', 'Finds a value'], [1, 'typescript', 'useCounter']] as const) {
    await click(`pr-file-${index}`)
    await waitForPainted(a, text)
    await Bun.sleep(600)
    await a.screenshot({ path: `${out}/${name}-${mode}.png` })
  }
  assert.ok(true)
  console.log(`PASS syntax ${mode}`)
} catch (error) {
  await a.screenshot({ path: `${out}/failure-${mode}.png` }).catch(() => {})
  console.log(f.diagnostics())
  throw error
} finally { await f.close(); fixture.close() }
