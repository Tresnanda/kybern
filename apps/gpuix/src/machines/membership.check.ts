// Run serially with the other native UI checks: bun src/machines/membership.check.ts.
// Uses the patched addon selected by NAPI_RS_NATIVE_LIBRARY_PATH and temporary loopback-only data.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { acquirePreviewUiLock } from '../../scripts/preview-ui-lock.ts'

const out = path.resolve(process.env.KYBERN_VERIFY_OUTPUT ?? 'native/build/membership')
mkdirSync(out, { recursive: true })
const release = acquirePreviewUiLock()
try {
  for (const theme of ['dark', 'light']) for (const width of [1000, 640]) {
    const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-membership-'))
    const f = await launchFixture(path.join(import.meta.dir, 'membership.fixture.tsx'), {
      GPUIX_BACKGROUND: '1', KYBERN_NO_ACTIVATE: '1', KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1',
      KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
      KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', MEMBERSHIP_WIDTH: String(width),
      KYBERN_REDUCED_MOTION: width === 640 ? '1' : '0', KYBERN_REDUCED_TRANSPARENCY: width === 640 ? '1' : '0',
    })
    const a = f.app
    const wait = async (read: () => Promise<boolean>, label: string) => {
      const deadline = Date.now() + 15000
      while (!await read()) { if (Date.now() >= deadline) throw Error(`Timed out: ${label}`); await Bun.sleep(40) }
    }
    const click = async (id: string) => { await a.getByTestId(id).waitFor(); await a.getByTestId(id).click() }
    const text = (id: string) => a.getByTestId(id).textContent()
    try {
      await a.getByTestId('fixture-ready').waitFor({ timeoutMs: 60000 })
      await wait(async () => (await text('fixture-members')) === 'Members: ', 'all saved records start member:false')
      await click('fixture-enable')
      await wait(async () => (await text('fixture-members')).includes('SatyaMas'), 'enable discovers SatyaMas')
      await wait(async () => (await text('fixture-targets')).includes('SatyaMas'), 'provision sees SatyaMas')
      await click('machine-filter')
      await a.getByTestId('machine-filter-satya').waitFor()
      await Bun.sleep(300)
      await a.screenshot({ path: path.join(out, `${theme}-${width}-sidebar.png`) })
      await a.call('keystrokes', { keys: 'escape' })
      await click('login-broker-machine')
      await a.getByTestId('login-broker-machine-satya').waitFor()
      await Bun.sleep(300)
      await a.screenshot({ path: path.join(out, `${theme}-${width}-broker.png`) })
      await a.call('keystrokes', { keys: 'escape' })
      assert.equal(await text('login-broker-machine'), 'None')
      assert.equal(await text('fixture-broker-changes'), 'Broker changes: 0')
      // Merely considering a broker opens a confirmation; Escape cancels without changing credentials.
      await a.call('keystrokes', { keys: 'enter' })
      await a.getByTestId('login-broker-machine-satya').waitFor()
      await click('login-broker-machine-satya')
      await a.getByTestId('login-broker-move').waitFor()
      await a.call('keystrokes', { keys: 'escape' })
      await wait(async () => await a.getByTestId('login-broker-move').count() === 0, 'Escape closes confirmation')
      assert.equal(await text('fixture-broker-changes'), 'Broker changes: 0')
      await a.call('keystrokes', { keys: 'enter' })
      await a.getByTestId('login-broker-machine-satya').waitFor()
      await a.call('keystrokes', { keys: 'escape' })
      await click('fixture-join')
      await wait(async () => (await text('fixture-members')).includes('Later machine'), 'join notification updates members')
      await click('fixture-remove')
      await wait(async () => !(await text('fixture-members')).includes('SatyaMas'), 'remove notification updates members')
      await click('fixture-enable')
      await wait(async () => !(await text('fixture-members')).includes('MacBook Pro'), 'disable demotes primary')
      await click('fixture-enable')
      await wait(async () => (await text('fixture-members')).includes('MacBook Pro'), 'enable again promotes primary')
      await a.screenshot({ path: path.join(out, `${theme}-${width}-final.png`) })
      console.log(`PASS ${theme} ${width}: live membership, sidebar, broker None/cancel, provision, joins/removals, disable/re-enable`)
    } catch (error) { console.error(f.diagnostics()); throw error }
    finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
  }
} finally { release() }
