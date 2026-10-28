/** The pull request sidebar in each verdict state against the in-memory fixture: screenshots for the wide window and the dock width. */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { captureWindow } from '../transcript/live.ts'
import { actionFixture } from './verify.fixture.ts'
import { PR_STATES, type PrState } from './verify.states.ts'

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
const mode = process.argv.includes('--light') ? 'light' : 'dark'
const narrow = process.argv.includes('--narrow')
const states = (arg('states')?.split(',') ?? PR_STATES) as PrState[]
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/tmp/gpuix-pr-sidebar'
mkdirSync(out, { recursive: true })
for (const state of states) {
  const fixture = actionFixture({ state })
  const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode, KYBERN_WINDOW_SIZE: narrow ? '980x760' : '1440x900' })
  const a = f.app
  const tag = `${state}-${narrow ? 'narrow' : 'wide'}-${mode}`
  const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(350) }
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
    await click('rail-pulls')
    await click('pr-row-108')
    await a.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 })
    await Bun.sleep(1800)
    const file = `${out}/${tag}.png`
    try { captureWindow(f.pid, file) } catch { await a.screenshot({ path: file }) }
    console.log(`shot ${file}`)
  } catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close(); fixture.close() }
}
