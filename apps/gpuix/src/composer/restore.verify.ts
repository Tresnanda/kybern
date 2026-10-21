// A failed send's Edit restores the whole draft (review 2026-10-21: it restored only the text, dropping images and chips).
// conversation.fixture.tsx: attach an image, mention a note (a chip) and refer to the image, send; "Restore last send" (the
// Edit path) must bring back the text, the chip and the image tile, and sending again must send the same parts.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
async function until(check: () => Promise<boolean>, what: string) { for (let i = 0; i < 200; i++) { try { if (await check()) return } catch {} await Bun.sleep(50) } throw Error(`Timed out: ${what}`) }
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/motion/gpuixfix/restore'
mkdirSync(out, { recursive: true })
const image = new URL('../../../desktop/src-tauri/icons/128x128@2x.png', import.meta.url).pathname
for (const variant of process.env.RESTORE_THEMES?.split(',') ?? ['dark', 'light']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-restore-')
  const f = await launchFixture(import.meta.dir + '/conversation.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ATTACH: image })
  try {
    const app = f.app
    const painted = async () => String((await app.call('getPaintedText', {})).text)
    await app.getByTestId('conversation-ready').waitFor()
    await until(async () => await app.getByTestId('connected').textContent() === 'open', 'connected')
    await until(async () => (await app.getByTestId('attachment-image1').count()) > 0, 'attachment tile')
    await app.getByTestId('composer').fill('Compare @image1 with @Release')
    await until(async () => (await app.getByTestId('completion-selected').textContent()).includes('Release'), 'mention picker')
    await app.getByTestId('composer').press('enter')
    await until(async () => (await painted()).includes('Release notes'), 'chip')
    await app.screenshot({ path: `${out}/${variant}-draft.png` })
    await app.getByTestId('composer').press('enter')
    await until(async () => (await app.getByTestId('message-record').textContent()) !== 'null', 'send')
    const first = await app.getByTestId('message-record').textContent()
    const parts = JSON.parse(first).parts as { type: string; asset_id?: string; path?: string }[]
    assert.ok(parts.some(p => p.type === 'attachment' && p.asset_id === 'asset-1'), `sent the image: ${first}`)
    assert.ok(parts.some(p => p.type === 'mention' && p.path === 'kybern://note/note'), `sent the chip: ${first}`)
    await until(async () => (await app.getByTestId('attachment-image1').count()) === 0, 'composer cleared')
    await app.getByTestId('restore-sent').click()
    await until(async () => (await app.getByTestId('attachment-image1').count()) > 0, 'image tile restored')
    await until(async () => (await painted()).includes('Release notes'), 'chip restored')
    await app.screenshot({ path: `${out}/${variant}-restored.png` })
    await app.getByTestId('composer').press('enter')
    await until(async () => (await app.getByTestId('attachment-image1').count()) === 0, 'resent')
    await until(async () => (await app.getByTestId('message-record').textContent()) !== first || true, 'record')
    assert.deepEqual(JSON.parse(await app.getByTestId('message-record').textContent()), JSON.parse(first), 'the restored draft sends the same parts')
    console.log(`${variant}: Edit restores text, chip and image; resending sends the same parts`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
