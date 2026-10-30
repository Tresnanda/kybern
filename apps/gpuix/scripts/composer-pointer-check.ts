/**
 * Composer pickers in the normal app shell: real pointer click, then assert the popup is visible.
 * Runs with motion and glass ON (visual-pair forces reduced motion + opaque, which hid the bug).
 *
 *   bun scripts/composer-pointer-check.ts [--reduced] [--opaque] [--light] [--out dir]
 * Scratch data only (visual-pair slot daemon).
 */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { ids as settingsIds } from '../visual/fixture.settings.ts'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR, readState, connect } from '../visual/fixture.ts'
const args = process.argv.slice(2)
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : '/Users/mymac/projects/ade/previews/gpuix/composer3/check'
mkdirSync(out, { recursive: true })
const state = readState()
if (!state) throw new Error('start the scratch daemon: bun scripts/visual-pair.ts conversation-empty --gpuix-only --keep')
const client = await connect(state)
try { await settingsIds(client) } finally { client.close() }
const env: Record<string, string> = { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: args.includes('--light') ? 'light' : 'dark', KYBERN_DATA_DIR: DATA_DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_ENVIRONMENT_NAME: 'Development environment' }
if (!args.includes('--draft')) env.KYBERN_GPUIX_THREAD = 'Date helper cleanup'
if (args.includes('--reduced')) env.KYBERN_REDUCED_MOTION = '1'
if (args.includes('--opaque')) env.KYBERN_OPAQUE = '1'
const fixture = await launchFixture(path.resolve(import.meta.dir, '../src/main.tsx'), env)
const app = fixture.app
const guard = setTimeout(() => { console.error('Composer pointer check exceeded its 90 s deadline'); void fixture.close(); process.exit(1) }, 90_000)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (label: string, check: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await check()) return true } catch {} await wait(50) } return false }
const has = async (id: string) => (await app.getByTestId(id).count()) > 0
const results: string[] = []
const fail: string[] = []
/** A human click: travel onto the target, dwell, press, hold, release (the plain `click` skips the hover and the hold). */
async function press(testId: string) {
  const at = await app.getByTestId(testId).center()
  const mode = args.includes('--real') ? 'real' : (args.find((a) => a.startsWith('--click='))?.slice(8) ?? 'real')
  if (mode === 'click') { await app.mouse.click(at); return }
  if (mode === 'move-click') { await app.mouse.move(at); await wait(120); await app.mouse.click(at); return }
  if (mode === 'down-up') { await app.mouse.down(at); await wait(70); await app.mouse.up(at); return }
  if (mode === 'move-down-up') { await app.mouse.move(at); await app.mouse.down(at); await app.mouse.up(at); return }
  await app.mouse.move({ x: at.x - 40, y: at.y - 20 })
  for (let i = 1; i <= 4; i++) { await app.mouse.move({ x: at.x - 40 + (i * 40) / 4, y: at.y - 20 + (i * 20) / 4 }); await wait(16) }
  await wait(120)
  await app.mouse.down(at)
  await wait(70)
  await app.mouse.up(at)
}
async function check(name: string, trigger: string, popup: string, then?: () => Promise<void>) {
  console.log(`stage: press ${name}`)
  await press(trigger)
  const ok = await until(name, () => has(popup), 5000)
  if (!ok) {
    const bounds = await app.getByTestId(trigger).bounds()
    console.log(`  ${name}: first press failed; trigger bounds ${JSON.stringify(bounds)}`)
  }
  await wait(400)
  await app.screenshot({ path: path.join(out, `${name}.png`) })
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) fail.push(name)
  if (ok && then) await then()
  await app.getByTestId('app-ready').press('escape').catch(() => {})
  const closed = await until('closed', async () => !(await has(popup)), 2000)
  if (!closed) { fail.push(`${name}-escape`); results.push(`FAIL ${name} popup did not close on Escape`); await app.mouse.click({ x: 700, y: 300 }); await wait(300) }
}
try {
  console.log('stage: connected automation')
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  console.log('stage: app ready')
  await until('sidebar', () => has('rail-home'), 30000)
  await wait(1800)
  console.log('stage: sidebar ready')
  const surface = args.includes('--draft') ? 'draft' : 'thread'
  if (surface === 'thread') {
    await app.getByTestId('composer').waitFor({ timeoutMs: 15000 })
  } else {
    await app.getByTestId('rail-home').click()
    await wait(600)
  }
  await wait(1200)
  if (surface === 'thread') {
    await check('model', 'model-picker', 'model-picker-panel')
    await check('mode', 'mode-picker', 'mode-picker-menu')
    await check('plus', 'composer-plus', 'composer-plus-menu')
  } else {
    await check('tray-project', 'tray-project', 'tray-project-menu')
    await check('tray-workspace', 'tray-workspace', 'tray-workspace-menu')
    await check('tray-branch', 'tray-branch', 'tray-branch-menu')
    await check('model', 'model-picker', 'model-picker-panel', async () => {
      await app.getByTestId('effort-slider').waitFor()
      await app.getByTestId('effort-slider').press('home')
      if (!await until('low effort', () => app.getByText('Low').count().then(n => n > 0))) throw Error('Low effort precondition failed')
      const box = await app.getByTestId('effort-slider').bounds()
      await app.mouse.move({ x: box.x + box.width - 8, y: box.y + box.height / 2 })
      await wait(150)
      await app.mouse.click({ x: box.x + box.width - 8, y: box.y + box.height / 2 })
      if (!await until('high effort', () => app.getByText('High').count().then(n => n > 0))) throw Error('High effort did not become visible')
      results.push('PASS effort selection')
    })
    await check('mode', 'mode-picker', 'mode-picker-menu')
    await check('plus', 'composer-plus', 'composer-plus-menu')
  }
  if (args.includes('--draft')) {
    await press('rail-settings')
    await press('settings-tab-machines')
    await press('machines-add-ssh')
    await app.getByTestId('environment-machine').waitFor()
    await press('environment-tab-address')
    await app.getByTestId('environment-address').waitFor()
    await wait(260)
    await app.screenshot({ path: path.join(out, 'environment-address.png') })
    await app.getByTestId('environment-tab-ssh').press('enter')
    await app.getByTestId('environment-machine').waitFor()
    await app.screenshot({ path: path.join(out, 'environment-ssh-keyboard.png') })
    results.push('PASS environment tabs pointer and keyboard')
    await app.getByTestId('app-ready').press('escape')
  }
  for (const [name, value] of [['mentions', '@'], ['slash', '/attach']] as const) {
    await app.getByTestId('composer').fill(value)
    if (!await until(name, () => has('completion'))) throw Error(`${name} popup did not open`)
    await app.screenshot({ path: path.join(out, `${name}.png`) })
    results.push(`PASS ${name}`)
    await app.getByTestId('composer').press('escape')
    await app.getByTestId('composer').fill('')
  }
} finally {
  clearTimeout(guard)
  console.log(results.join('\n'))
  await fixture.close()
}
if (fail.length) { console.log('FAILED:', fail.join(', ')); process.exit(1) }
process.exit(0)
