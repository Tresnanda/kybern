// ADE-101 real native interaction checks. No real remote machine or daemon is touched.
// NAPI_RS_NATIVE_LIBRARY_PATH=<compatible addon> bun src/provision/machineSetup.check.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
const out = process.env.SHOT_OUT ?? path.resolve('.kybern-artifacts/machine-setup')
mkdirSync(out, { recursive: true })
for (const [appearance, width, reduced] of [['dark', '860', '0'], ['light', '460', '0'], ['dark', '460', '1']]) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'kybern-machine-setup-'))
  const statePath = path.join(scratch, 'evidence.json')
  const fixture = await launchFixture(path.join(import.meta.dir, 'machineSetup.fixture.tsx'), {
    KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_APPEARANCE: appearance!, KYBERN_OPAQUE: '1',
    KYBERN_REDUCED_MOTION: reduced!, GPUIX_BACKGROUND: '1', SETUP_WIDTH: width!, SETUP_STATE_PATH: statePath,
  })
  const app = fixture.app
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const tick = () => new Promise((resolve) => setTimeout(resolve, 80))
  const until = async (fn: () => boolean | Promise<boolean>, label: string) => {
    const end = Date.now() + 12000
    while (Date.now() < end) { if (await fn()) return; await tick() }
    throw new Error(`Timed out: ${label}`)
  }
  const click = async (id: string) => { await app.getByTestId(id).waitFor({ timeoutMs: 12000 }); await app.getByTestId(id).click(); await tick() }
  const ready = async () => { await app.getByTestId('machine-setup-add').waitFor(); await new Promise((resolve) => setTimeout(resolve, 700)) }
  try {
    await app.getByTestId('setup-fixture').waitFor({ timeoutMs: 45000 })
    // The missing-project menu row opens setup; Escape leaves the draft and current target unchanged.
    await click('machine-picker')
    await click('machine-pc')
    await app.getByTestId('machine-setup-sheet').waitFor({ timeoutMs: 12000 })
    await app.getByTestId('machine-setup-sheet').press('escape')
    await until(async () => await app.getByTestId('machine-setup-sheet').count() === 0, 'Escape dismisses setup')
    assert.equal(state().requests.length, 0)
    assert.equal(state().selected, 'Mac')
    // Escape restores the picker trigger: Enter reopens it, arrow keys reach the missing machine.
    await app.call('keystrokes', { keys: 'enter' })
    await app.getByTestId('machine-pc').waitFor({ timeoutMs: 5000 })
    for (const keys of ['down', 'down', 'enter']) { await app.call('keystrokes', { keys }); await tick() }
    await app.getByTestId('machine-setup-sheet').waitFor({ timeoutMs: 5000 })
    await app.getByTestId('machine-setup-sheet').press('escape')
    await until(async () => await app.getByTestId('machine-setup-sheet').count() === 0, 'keyboard setup cancelled')
    await click('open-setup')
    await click('machine-setup-cancel')
    await until(() => state().closed === 1, 'Cancel closes')
    assert.equal(state().draft, 'Keep this draft and its repository choices')
    // Inline capture uses the same content; native window snapshots omit popup layers.
    await click('open-inline')
    await ready()
    await app.screenshot({ path: path.join(out, `confirm-${appearance}-${width}-${reduced}.png`) })
    await click('machine-setup-all')
    await ready()
    const targets = await app.getByTestId('machine-setup-sheet').textContent()
    assert.ok(targets.includes('Targets: Windows PC, Build server, Travel laptop'))
    assert.ok(!targets.includes('Already complete'))
    await click('machine-setup-env-pc-api/.env.local')
    await app.getByTestId('machine-setup-folder-pc').fill('D:\\work\\launch-custom')
    await ready()
    const addBounds = await app.getByTestId('machine-setup-add').bounds()
    assert.ok(addBounds.y + addBounds.height <= 900, 'primary action stays inside the window')
    await app.screenshot({ path: path.join(out, `bulk-${appearance}-${width}-${reduced}.png`) })
    await click('machine-setup-add')
    await until(() => state().requests.length === 3 && state().selections === 1, 'batch started and original target selected')
    const calls = state().requests
    assert.deepEqual(calls.find((call: any) => call.machine === 'pc').env_files, ['api/.env.local'])
    assert.deepEqual(calls.find((call: any) => call.machine === 'vps').env_files, [])
    assert.deepEqual(calls.find((call: any) => call.machine === 'offline').env_files, [])
    assert.equal(calls.find((call: any) => call.machine === 'pc').path, 'D:\\work\\launch-custom')
    await app.getByTestId('machine-setup-retry-vps').waitFor({ timeoutMs: 12000 })
    await app.screenshot({ path: path.join(out, `partial-${appearance}-${width}-${reduced}.png`) })
    await click('machine-setup-retry-vps')
    await app.getByTestId('machine-setup-submit-vps').waitFor(); await new Promise((resolve) => setTimeout(resolve, 700))
    await click('machine-setup-submit-vps')
    await until(() => state().requests.length === 4, 'only failed target retried')
    await until(async () => (await app.getByTestId('machine-setup-vps').textContent()).includes('Added to Build server'), 'retry completed')
    assert.equal(state().requests.filter((call: any) => call.machine === 'pc').length, 1)
    assert.equal(state().requests.filter((call: any) => call.machine === 'offline').length, 1)
    assert.equal(state().selected, 'Windows PC')
    assert.equal(state().selections, 1)
    assert.deepEqual(state().mappings, ['pc', 'vps'])
    assert.equal(state().draft, 'Keep this draft and its repository choices')
    await app.screenshot({ path: path.join(out, `complete-${appearance}-${width}-${reduced}.png`) })
    await click('machine-setup-cancel')
    console.log(`PASS ${appearance} ${width}px reduced=${reduced}: picker, Escape, Cancel, per-target consent/path, partial group, batch, offline queue, retry, draft, selection`)
  } catch (error) {
    console.error('STATE', JSON.stringify(state()), fixture.diagnostics())
    try { await app.screenshot({ path: path.join(out, `failure-${appearance}-${width}-${reduced}.png`) }) } catch {}
    throw error
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
