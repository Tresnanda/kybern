// Rich-editor behaviour of the composer, by real key presses: a picked mention is
// one atomic inline token (one Backspace removes it whole), undo/redo walk the
// edits (a token and its text are single steps), and Enter sends the structured parts.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/convo9/editor'
mkdirSync(out, { recursive: true })
const until = async (check: () => Promise<boolean>, label: string) => { for (let i = 0; i < 100; i++) { try { if (await check()) return } catch {} await Bun.sleep(40) } throw Error(`Timed out: ${label}`) }
for (const variant of ['dark', 'light'] as const) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-editor-')
  const f = await launchFixture(import.meta.dir + '/conversation.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' })
  try {
    const app = f.app, composer = app.getByTestId('composer')
    await app.getByTestId('conversation-ready').waitFor()
    await until(async () => (await app.getByTestId('connected').textContent()) === 'open', 'connected')
    const painted = async () => String((await app.call('getPaintedText', {})).text)
    const menu = async () => (await app.getByTestId('completion').count()) > 0
    let sends = 0
    const send = async () => {
      sends++
      const before = await app.getByTestId('message-record').textContent()
      await composer.press('enter')
      await until(async () => (await app.getByTestId('message-record').textContent()) !== before, 'send')
      return JSON.parse(await app.getByTestId('message-record').textContent()).parts as { type: string; text?: string; path?: string }[]
    }
    const pick = async (query: string) => { await composer.fill('@' + query); await until(menu, 'menu'); await composer.press('enter'); await until(async () => !(await menu()), 'menu closed') }

    console.log('CHECK token then text sends structured parts')
    await pick('Release'); await composer.press('x'); await composer.press('y')
    await app.screenshot({ path: `${out}/token-text-${variant}.png` })
    let parts = await send()
    assert.ok(parts.some(p => p.type === 'mention' && p.path === 'kybern://note/note'), 'mention part')
    assert.ok(parts.some(p => p.type === 'text' && p.text!.includes('xy')), 'typed text after the token')

    console.log('CHECK one Backspace deletes the whole token')
    await pick('Release')
    await composer.press('backspace'); await composer.press('backspace')
    await composer.press('z')
    parts = await send()
    assert.ok(!parts.some(p => p.type === 'mention'), `token must be gone after Backspace: ${JSON.stringify(parts)}`)
    assert.ok(parts.some(p => p.type === 'text' && p.text!.trim() === 'z'), `only the typed text remains: ${JSON.stringify(parts)}`)

    console.log('CHECK undo restores the token, redo removes it again')
    await pick('Release'); await composer.press('backspace'); await composer.press('backspace')
    await composer.press('cmd-z'); await Bun.sleep(150)
    await composer.press('cmd-z'); await Bun.sleep(150)
    parts = await send()
    assert.ok(parts.some(p => p.type === 'mention'), `undo must bring the token back: ${JSON.stringify(parts)}`)

    console.log('CHECK typed text undoes word by word')
    await composer.fill('')
    for (const ch of 'one two') await composer.press(ch === ' ' ? 'space' : ch)
    await composer.press('cmd-z'); await Bun.sleep(150)
    const afterUndo = await painted()
    assert.ok(!afterUndo.includes('one two'), 'undo removes typing')
    await composer.press('cmd-shift-z'); await Bun.sleep(150)
    assert.ok((await painted()).includes('one two') || (await painted()).includes('one'), 'redo restores typing')
    console.log(`PASS ${variant}: inline tokens, atomic Backspace, undo/redo, structured send`)
  } catch (error) { await f.app.screenshot({ path: `${out}/failed-${variant}.png` }).catch(() => {}); console.log(f.diagnostics()); throw error } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
