// The @ and $ pickers mark what the draft already holds, and picking it again removes it:
//   NAPI_RS_NATIVE_LIBRARY_PATH=…patched.node bun src/composer/attached.verify.ts
// Picks a note, a file, a skill and an uploaded image, reopens the pickers (screenshots, dark and light), then toggles each off
// and checks the draft's text and the rows. A repeated file in one attach batch is attached once, with a quiet note.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-54-58/L6'
const image = '/Users/mymac/projects/ade/.kybern-artifacts/ade-approval-design/family-dark.png'
mkdirSync(out, { recursive: true })
const until = async (check: () => Promise<boolean>, label: string) => { for (let i = 0; i < 100; i++) { try { if (await check()) return } catch {} await Bun.sleep(40) } throw Error(`Timed out: ${label}`) }
let failures = 0
for (const theme of (process.env.ATTACHED_THEMES ?? 'dark,light').split(',')) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-attached-')
  const f = await launchFixture(import.meta.dir + '/conversation.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_FIXTURE_FILES: 'src/Composer.tsx,src/composer/Completion.tsx', KYBERN_GPUIX_ATTACH: `${image},${image}` })
  try {
    const app = f.app, composer = app.getByTestId('composer')
    await app.getByTestId('conversation-ready').waitFor()
    await until(async () => (await app.getByTestId('connected').textContent()) === 'open', 'connected')
    const painted = async () => String((await app.call('getPaintedText', {})).text)
    const menu = async () => (await app.getByTestId('completion').count()) > 0
    const marks = async () => app.getByType('div').all().then(() => 0).catch(() => 0)
    const attachedRows = async () => { let n = 0; for (let i = 0; i < 12; i++) n += await app.getByTestId(`completion-attached-${i}`).count(); return n }
    // The two identical paths attach once, with a note.
    await until(async () => (await painted()).includes('image1'), 'attachment tile')
    assert.ok(!(await painted()).includes('image2'), 'the duplicate path attached twice')
    assert.ok((await painted()).includes('already attached'), 'no note about the duplicate')
    const open = async (trigger: string) => { await composer.press(trigger); await until(menu, `menu ${trigger}`); await Bun.sleep(180) }
    const pickText = async (row: string) => {
      let clicked = false
      for (let i = 0; i < 14 && !clicked; i++) { const r = app.getByTestId(`completion-${i}`); if (await r.count() && (await r.textContent()).includes(row)) { await r.click(); clicked = true } }
      assert.ok(clicked, `no row for ${row}`)
      await until(async () => !(await menu()), `closed after ${row}`); await Bun.sleep(150)
    }
    const dismiss = async () => { await composer.press('escape'); await until(async () => !(await menu()), 'dismissed'); await Bun.sleep(100) }
    await open('@')
    await pickText('Release notes')
    await open('@')
    await pickText('Composer.tsx')
    await open('$')
    await pickText('Review UI')
    console.log(theme, 'draft', (await painted()).replace(/\s+/g, ' ').slice(0, 400))
    await open('@')
    await app.screenshot({ path: `${out}/picker-attached-${theme}.png` })
    console.log(theme, 'marked rows after @:', await attachedRows())
    await dismiss()
    await composer.press('backspace')
    await open('$')
    await app.screenshot({ path: `${out}/picker-skill-attached-${theme}.png` })
    console.log(theme, 'marked rows after $:', await attachedRows())
    await dismiss()
    // Picking each again removes it.
    await composer.press('backspace')
    const draft = async () => (await painted()).split('claude-code model')[0]!
    console.log(theme, 'start')
    for (const [trigger, row, chip] of [['@', 'Release notes', 'Release notes'], ['@', 'Composer.tsx', 'src/Composer.tsx'], ['$', 'Review UI', 'review-ui']] as const) {
      await open(trigger)
      await pickText(row)
      const after = await draft()
      assert.ok(!after.includes(chip), `${chip} still in the draft after picking it again: ${after.slice(-120)}`)
      console.log(theme, 'removed', chip)
    }
    // The image: placing it in the prompt marks it, and picking it again takes the mention (the tile stays).
    await open('@')
    await pickText('family-dark.png')
    assert.ok((await painted()).includes('@image1'))
    await open('@')
    assert.equal(await attachedRows(), 1, 'the placed image should be marked')
    await app.screenshot({ path: `${out}/picker-image-attached-${theme}.png` })
    await pickText('family-dark.png')
    assert.ok((await painted()).includes('@image1'), 'the tile should stay')
    // Deleting a chip in the editor un-marks its row.
    await open('@')
    await pickText('Release notes')
    await composer.press('backspace')
    await composer.press('backspace')
    await open('@')
    assert.equal(await attachedRows(), 0, 'a deleted chip should not stay marked')
    console.log(theme, 'ok')
  } catch (error) { failures++; await f.app.screenshot({ path: `${out}/attached-failed-${theme}.png` }).catch(() => {}); console.log(String(error)); console.log(f.diagnostics().slice(-1500)) } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(failures ? 1 : 0)
